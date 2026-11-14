/*
 * sqlite3_busy_handler bridge for better-sqlite3 13.0.3 (SQLite 3.53.4).
 *
 * The same shared object is loaded twice in-process: once by Node as an N-API
 * addon (`arm`/`disarm`), and once by better-sqlite3's own
 * `Database#loadExtension(path, "sqlite3_f7busy_init")`.  The dynamic loader
 * returns the already-loaded image for the same path, so the SQLite entry point
 * sees the per-thread arm slot written by `arm`, and receives the exact
 * `sqlite3*` of that Database together with its API routine table.  No SQLite
 * symbol is linked here; every call goes through `pApi`.
 *
 * The busy callback runs synchronously inside the sqlite3_step that hit the
 * lock, on the JS thread that owns the connection, and calls the armed JS
 * function with the prior-invocation count.  State is attached with
 * sqlite3_set_clientdata, so replacing the handler, clearing it, or closing
 * the connection runs `destroy_state` and releases the function reference.
 */
#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include "sqlite3ext.h"

#if defined(_MSC_VER)
#define F7_THREAD_LOCAL __declspec(thread)
#define F7_EXPORT __declspec(dllexport)
#else
#define F7_THREAD_LOCAL _Thread_local
#define F7_EXPORT __attribute__((visibility("default")))
#endif

static const char kClientDataName[] = "f7.busy_handler";

typedef struct BusyInstance BusyInstance;

typedef struct BusyState {
  napi_env env;
  napi_ref fn;
  BusyInstance *instance;
  struct BusyState *prev;
  struct BusyState *next;
} BusyState;

struct BusyInstance {
  BusyState *head;
};

typedef struct {
  int armed;
  napi_env env;
  napi_ref fn;
  BusyInstance *instance;
} BusyArm;

/* One slot per thread: worker_threads each own their connections and env. */
static F7_THREAD_LOCAL BusyArm g_arm;

static void unlink_state(BusyState *s) {
  if (s->instance == NULL) return;
  if (s->prev) s->prev->next = s->next;
  else s->instance->head = s->next;
  if (s->next) s->next->prev = s->prev;
  s->prev = s->next = NULL;
  s->instance = NULL;
}

/* SQLite clientdata destructor: replacement, clear, or sqlite3_close. */
static void destroy_state(void *p) {
  BusyState *s = (BusyState *)p;
  if (s->env != NULL && s->fn != NULL) napi_delete_reference(s->env, s->fn);
  unlink_state(s);
  free(s);
}

static void clear_arm(void) {
  if (g_arm.fn != NULL && g_arm.env != NULL) napi_delete_reference(g_arm.env, g_arm.fn);
  g_arm.armed = 0;
  g_arm.env = NULL;
  g_arm.fn = NULL;
  g_arm.instance = NULL;
}

/* Env teardown: drop references while the env is valid and detach every state
 * so a later sqlite3_close (from better-sqlite3's own cleanup hook) only frees
 * memory and a late busy callback declines instead of touching a dead env. */
static void finalize_instance(napi_env env, void *data, void *hint) {
  (void)hint;
  BusyInstance *instance = (BusyInstance *)data;
  BusyState *s = instance->head;
  while (s != NULL) {
    BusyState *next = s->next;
    if (s->fn != NULL) napi_delete_reference(env, s->fn);
    s->env = NULL;
    s->fn = NULL;
    s->instance = NULL;
    s->prev = s->next = NULL;
    s = next;
  }
  instance->head = NULL;
  if (g_arm.instance == instance) clear_arm();
  free(instance);
}

static int busy_callback(void *p, int prior_invocations) {
  BusyState *s = (BusyState *)p;
  if (s->env == NULL || s->fn == NULL) return 0;
  napi_env env = s->env;
  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return 0;
  int keep_waiting = 0;
  napi_value fn, global, argv[1], result;
  if (napi_get_reference_value(env, s->fn, &fn) == napi_ok && fn != NULL
      && napi_get_global(env, &global) == napi_ok
      && napi_create_int32(env, prior_invocations, &argv[0]) == napi_ok) {
    if (napi_call_function(env, global, fn, 1, argv, &result) == napi_ok) {
      bool value = false;
      if (napi_get_value_bool(env, result, &value) == napi_ok) keep_waiting = value ? 1 : 0;
    } else {
      /* rusqlite 0.40.1 busy.rs:60 treats a panicking callback as false
       * (catch_unwind(..).unwrap_or_default()) and never rethrows it.  Clear
       * the JS exception so it does not leak into an unrelated N-API call and
       * hand false back to SQLite. */
      bool pending = false;
      napi_value ignored;
      if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        napi_get_and_clear_last_exception(env, &ignored);
      }
    }
  }
  napi_close_handle_scope(env, scope);
  return keep_waiting;
}

F7_EXPORT int sqlite3_f7busy_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi) {
  if (!g_arm.armed) {
    *pzErrMsg = pApi->mprintf("f7 busy handler: extension entry point called without arm()");
    return SQLITE_ERROR;
  }
  if (g_arm.fn == NULL) {
    clear_arm();
    pApi->busy_handler(db, NULL, NULL);
    pApi->set_clientdata(db, kClientDataName, NULL, NULL);
    return SQLITE_OK;
  }
  BusyState *s = (BusyState *)calloc(1, sizeof(BusyState));
  if (s == NULL) {
    clear_arm();
    *pzErrMsg = pApi->mprintf("out of memory");
    return SQLITE_NOMEM;
  }
  s->env = g_arm.env;
  s->fn = g_arm.fn;
  s->instance = g_arm.instance;
  s->next = s->instance->head;
  if (s->next) s->next->prev = s;
  s->instance->head = s;
  g_arm.fn = NULL;
  clear_arm();
  /* Point SQLite at the new state before the old one is destroyed. */
  pApi->busy_handler(db, busy_callback, s);
  if (pApi->set_clientdata(db, kClientDataName, s, destroy_state) != SQLITE_OK) {
    /* Only reachable when no previous entry existed (allocation of a new
     * entry); set_clientdata has already destroyed `s`, so SQLite must not
     * keep pointing at it. */
    pApi->busy_handler(db, NULL, NULL);
    *pzErrMsg = pApi->mprintf("out of memory");
    return SQLITE_NOMEM;
  }
  return SQLITE_OK;
}

static napi_value js_arm(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  BusyInstance *instance = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, (void **)&instance) != napi_ok) return NULL;
  napi_valuetype type = napi_undefined;
  if (argc >= 1) napi_typeof(env, argv[0], &type);
  if (type != napi_function && type != napi_null) {
    napi_throw_type_error(env, NULL, "Expected a function or null");
    return NULL;
  }
  clear_arm();
  if (type == napi_function && napi_create_reference(env, argv[0], 1, &g_arm.fn) != napi_ok) return NULL;
  g_arm.armed = 1;
  g_arm.env = env;
  g_arm.instance = instance;
  return NULL;
}

/* Releases an arm that loadExtension did not consume (e.g. it threw). */
static napi_value js_disarm(napi_env env, napi_callback_info info) {
  (void)env;
  (void)info;
  clear_arm();
  return NULL;
}

NAPI_MODULE_INIT() {
  BusyInstance *instance = (BusyInstance *)calloc(1, sizeof(BusyInstance));
  if (instance == NULL) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  if (napi_set_instance_data(env, instance, finalize_instance, NULL) != napi_ok) {
    free(instance);
    return NULL;
  }
  napi_property_descriptor props[] = {
    { "arm", NULL, js_arm, NULL, NULL, NULL, napi_default, instance },
    { "disarm", NULL, js_disarm, NULL, NULL, NULL, napi_default, instance },
  };
  if (napi_define_properties(env, exports, 2, props) != napi_ok) return NULL;
  return exports;
}
