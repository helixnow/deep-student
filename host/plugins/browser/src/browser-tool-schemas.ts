/**
 * Single source of truth for the JSON schemas of all `builtin-browser_*` + `builtin-webpage_save`
 * worker tools.
 * 100% Web-API portable (no Node builtins or globals).
 */

import type { JsonValue } from './command-result.ts';

export interface BrowserWorkerToolSchema {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export function webpageSaveWorkerToolSchema(): BrowserWorkerToolSchema {
  return {
    name: 'builtin-webpage_save',
    description: 'Save extracted webpage Markdown content into the VFS knowledge base for indexing.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Source absolute HTTP/HTTPS URL (no embedded credentials).' },
        title: { type: 'string', description: 'Webpage title; derived from URL when omitted.' },
        content: { type: 'string', description: 'Complete Markdown body of the webpage.' },
        content_type: { type: 'string', description: 'Optional content MIME type metadata.' },
        folder_id: { type: 'string', description: 'Optional target VFS folder ID.' },
      },
      required: ['url', 'content'],
      additionalProperties: false,
    },
  };
}

const SCHEMAS: readonly BrowserWorkerToolSchema[] = [
  {
    name: 'builtin-browser_open',
    description: 'Open a URL in the built-in browser session and return an accessibility snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target http/https URL to open.' },
        new_context: { type: 'boolean', description: 'Close any existing session and start fresh.' },
        headless: { type: 'boolean', description: 'Prefer headless execution mode when supported.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_navigate',
    description: 'Navigate the active browser session to a new URL and return an updated snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target http/https URL to navigate to.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_snapshot',
    description: 'Capture a compact accessibility/DOM snapshot of the current page with e-prefixed element refs.',
    inputSchema: {
      type: 'object',
      properties: {
        interactive_only: { type: 'boolean', description: 'Include primarily interactive controls and landmarks (default true).' },
        max_chars: { type: 'integer', minimum: 500, maximum: 24000, description: 'Maximum characters to return.' },
        start_index: { type: 'integer', minimum: 0, description: 'Character offset for paging long snapshots.' },
        diff: { type: 'boolean', description: 'Return only line-level changes relative to the previous snapshot.' },
        selector: { type: 'string', description: 'Optional CSS selector to scope the snapshot.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_screenshot',
    description: 'Capture a real visual screenshot of the active browser page and store it as a task artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'Capture beyond the current viewport when supported.' },
        annotate: { type: 'boolean', description: 'Overlay interactive element ref labels on the screenshot.' },
        max_width: { type: 'integer', minimum: 200, maximum: 4096, description: 'Optional target maximum width in pixels.' },
        quality: { type: 'integer', minimum: 10, maximum: 100, description: 'Optional image quality (uses JPEG when below 100).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_click',
    description: 'Click an element by snapshot ref (e.g. e12) or viewport coordinates (x, y).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e12).' },
        x: { type: 'number', description: 'Viewport X coordinate when clicking by coordinates.' },
        y: { type: 'number', description: 'Viewport Y coordinate when clicking by coordinates.' },
        element: { type: 'string', description: 'Human-readable description of the target element.' },
        double_click: { type: 'boolean', description: 'Perform a double-click instead of a single click.' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button to click (default left).' },
        include_snapshot: { type: 'boolean', description: 'Include an updated page snapshot after clicking (default true).' },
        diff_snapshot: { type: 'boolean', description: 'Use diff mode for the post-action snapshot.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_type',
    description: 'Focus and type text into an input element by snapshot ref. Password/OTP fields are blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e5).' },
        element: { type: 'string', description: 'Human-readable description of the input element.' },
        text: { type: 'string', description: 'Text to type into the element.' },
        clear: { type: 'boolean', description: 'Clear existing text before typing.' },
        submit: { type: 'boolean', description: 'Press Enter after typing to submit.' },
        include_snapshot: { type: 'boolean', description: 'Include an updated page snapshot after typing (default true).' },
        diff_snapshot: { type: 'boolean', description: 'Use diff mode for the post-action snapshot.' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_hover',
    description: 'Move the pointer over an element by snapshot ref or viewport coordinates (x, y).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot.' },
        x: { type: 'number', description: 'Viewport X coordinate.' },
        y: { type: 'number', description: 'Viewport Y coordinate.' },
        element: { type: 'string', description: 'Human-readable description of the target element.' },
        include_snapshot: { type: 'boolean', description: 'Include an updated page snapshot after hovering.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_press_key',
    description: 'Send a keyboard key press (e.g. Enter, Escape, Tab, ArrowDown) with optional modifier keys.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name to press (e.g. Enter, Escape, Tab, ArrowDown, a).' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
          description: 'Optional modifier keys held during the key press.',
        },
        include_snapshot: { type: 'boolean', description: 'Include an updated page snapshot after pressing the key.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_select_option',
    description: 'Select one or more options in a <select> dropdown element by snapshot ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the select element.' },
        values: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Option values or labels to select.',
        },
        element: { type: 'string', description: 'Human-readable description of the select element.' },
        include_snapshot: { type: 'boolean', description: 'Include an updated page snapshot after selection.' },
      },
      required: ['ref', 'values'],
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_wait_for',
    description: 'Wait until specified text appears, a CSS selector matches, or a page load state is reached.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to wait for in visible page text.' },
        selector: { type: 'string', description: 'CSS selector to wait for in the DOM.' },
        load_state: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Page lifecycle state to wait for.',
        },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 30000, description: 'Maximum time to wait in milliseconds.' },
        include_snapshot: { type: 'boolean', description: 'Include an updated page snapshot once condition is met.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_extract_content',
    description: 'Extract the main readable content of the current page as clean Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        max_chars: { type: 'integer', minimum: 500, maximum: 24000, description: 'Maximum characters to return.' },
        start_index: { type: 'integer', minimum: 0, description: 'Character offset for paging long extracts.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_file_upload',
    description: 'Attach authorized workspace or artifact files to a file input element by snapshot ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the file input.' },
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              root_id: { type: 'string', description: 'Runtime root identifier (workspace, authorized root, or artifacts).' },
              relative_path: { type: 'string', description: 'Relative path inside the runtime root.' },
            },
            required: ['root_id', 'relative_path'],
          },
          description: 'Authorized files to attach.',
        },
        element: { type: 'string', description: 'Human-readable description of the file input.' },
        include_snapshot: { type: 'boolean', description: 'Include an updated page snapshot after attaching files.' },
      },
      required: ['ref', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_downloads',
    description: 'List downloads triggered in the active browser session, optionally waiting for pending ones to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_for_terminal: { type: 'boolean', description: 'Wait until in-progress downloads reach a terminal state (default true).' },
        timeout_ms: { type: 'integer', minimum: 0, maximum: 30000, description: 'Maximum wait time in milliseconds.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_scroll',
    description: 'Scroll the page or a specific referenced element in a direction.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default down).' },
        amount: { type: 'number', description: 'Scroll amount in pixels or step units.' },
        ref: { type: 'string', description: 'Optional element ref to scroll into view or scroll within.' },
        include_snapshot: { type: 'boolean', description: 'Include an updated page snapshot after scrolling (default true).' },
        diff_snapshot: { type: 'boolean', description: 'Use diff mode for the post-action snapshot.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_back',
    description: 'Navigate back one entry in the browser session history.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_close',
    description: 'Close the active browser session and release its surface.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_tabs',
    description: 'List, open, switch, or close tabs in the active browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'switch', 'close'], description: 'Tab management operation.' },
        url: { type: 'string', description: 'Target URL when action is new.' },
        tab_id: { type: 'string', description: 'Target tab identifier when action is switch or close.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'builtin-browser_observe',
    description: 'Read recent browser console messages and/or network request logs for diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['console', 'network', 'both'], description: 'Log stream to inspect.' },
        level: { type: 'string', description: 'Optional console log level filter (e.g. error, warn, log).' },
        status_min: { type: 'integer', minimum: 100, maximum: 599, description: 'Optional minimum HTTP status code filter for network logs.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum number of entries to return.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  webpageSaveWorkerToolSchema(),
];

export const BROWSER_WORKER_TOOL_NAMES: readonly string[] = SCHEMAS.map(schema => schema.name);

export function browserWorkerToolSchemas(): BrowserWorkerToolSchema[] {
  return SCHEMAS.map(schema => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema,
  }));
}
