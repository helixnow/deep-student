import test from "node:test";
import assert from "node:assert/strict";

import { getAppLayoutPolicy } from "./app-layout-policy.ts";
import { createResponsiveEnvironment } from "./responsive-env.ts";

test("maps phone compact environments to drawer touch policy", () => {
  const policy = getAppLayoutPolicy(
    createResponsiveEnvironment({ width: 390, inputMode: "coarse" }),
  );

  assert.equal(policy.sidebarMode, "drawer");
  assert.equal(policy.density, "touch");
});

test("maps tablet compact environments to drawer touch policy", () => {
  const policy = getAppLayoutPolicy(
    createResponsiveEnvironment({ width: 768, inputMode: "coarse" }),
  );

  assert.equal(policy.sidebarMode, "drawer");
  assert.equal(policy.density, "touch");
});

test("maps fine desktop environments to docked desktop policy", () => {
  const policy = getAppLayoutPolicy(
    createResponsiveEnvironment({ width: 1024, inputMode: "fine" }),
  );

  assert.equal(policy.sidebarMode, "docked");
  assert.equal(policy.density, "desktop");
});

test("keeps coarse desktop environments docked while using touch density", () => {
  const policy = getAppLayoutPolicy(
    createResponsiveEnvironment({ width: 1280, inputMode: "coarse" }),
  );

  assert.equal(policy.sidebarMode, "docked");
  assert.equal(policy.density, "touch");
});

test("preserves environment facts while deriving app decisions", () => {
  const environment = createResponsiveEnvironment({ width: 1023, inputMode: "fine" });
  const policy = getAppLayoutPolicy(environment);

  assert.equal(policy.formFactor, environment.formFactor);
  assert.equal(policy.isCompact, environment.isCompact);
  assert.equal(policy.inputMode, environment.inputMode);
  assert.equal(policy.shellMode, environment.shellMode);
  assert.equal(policy.sidebarMode, "drawer");
  assert.equal(policy.density, "touch");
});
