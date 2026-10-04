/**
 * Browser tools of chrome-devtools-mcp 1.10.1
 * (https://github.com/ChromeDevTools/chrome-devtools-mcp, Apache-2.0): the
 * names, descriptions and input schemas of the allowed tools, as the pinned
 * version in `WEBDEV_DOCKERFILE` reports them, with every file path
 * parameter removed (`filePath`, `requestFilePath`, `responseFilePath`,
 * `outputDirPath`) and no other properties accepted. Generated; do not edit
 * by hand (regenerate when the pinned version changes).
 *
 * @module
 */

/** The allowed chrome-devtools-mcp tools (exposed as `browser_<name>`). */
export const BROWSER_TOOL_BASE_NAMES = ['navigate_page', 'take_snapshot', 'take_screenshot', 'click', 'fill', 'fill_form', 'press_key', 'type_text', 'hover', 'wait_for', 'handle_dialog', 'list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request', 'evaluate_script', 'emulate', 'resize_page', 'get_css_styles', 'lighthouse_audit', 'list_webmcp_tools', 'execute_webmcp_tool', 'list_pages'] as const;
export type BrowserToolBaseName = typeof BROWSER_TOOL_BASE_NAMES[number];

/** One allowed browser tool, as chrome-devtools-mcp names it (exposed as `browser_<name>`). */
export type BrowserToolSpec = { readonly name: BrowserToolBaseName; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>> };

/** The chrome-devtools-mcp version these specs come from (and the image pins). */
export const CHROME_DEVTOOLS_MCP_VERSION = '1.10.1';

export const BROWSER_TOOL_SPECS = [
  {
    "name": "navigate_page",
    "description": "Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "type": {
          "description": "Navigate the page by URL, back or forward in history, or reload.",
          "type": "string",
          "enum": [
            "url",
            "back",
            "forward",
            "reload"
          ]
        },
        "url": {
          "description": "Target URL (only type=url)",
          "type": "string"
        },
        "ignoreCache": {
          "description": "Whether to ignore cache on reload.",
          "type": "boolean"
        },
        "handleBeforeUnload": {
          "description": "Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept.",
          "type": "string",
          "enum": [
            "accept",
            "dismiss"
          ]
        },
        "initScript": {
          "description": "A JavaScript script to be executed on each new document before any other scripts for the next navigation.",
          "type": "string"
        },
        "timeout": {
          "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used.",
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "take_snapshot",
    "description": "Take a text snapshot of the target page based on the a11y tree. The snapshot lists page elements along with a unique\nidentifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected\nin the DevTools Elements panel (if any).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "verbose": {
          "description": "Whether to include all possible information available in the full a11y tree. Default is false.",
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "take_screenshot",
    "description": "Take a screenshot of the page or element.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "format": {
          "default": "png",
          "description": "Type of format to save the screenshot as. Default is \"png\"",
          "type": "string",
          "enum": [
            "png",
            "jpeg",
            "webp"
          ]
        },
        "quality": {
          "description": "Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.",
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "uid": {
          "description": "The uid of an element on the page from the page content snapshot. If omitted, takes a page screenshot.",
          "type": "string"
        },
        "fullPage": {
          "description": "If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.",
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "click",
    "description": "Clicks on the provided element",
    "inputSchema": {
      "type": "object",
      "properties": {
        "uid": {
          "type": "string",
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "dblClick": {
          "description": "Set to true for double clicks. Default is false.",
          "type": "boolean"
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "uid"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "fill",
    "description": "Type text into an input, text area or select an option from a <select> element.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "uid": {
          "type": "string",
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "value": {
          "type": "string",
          "description": "The value to fill in. \"true\" or \"false\" for checkboxes and toggles, \"true\" for radio buttons."
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "uid",
        "value"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "fill_form",
    "description": "Fill out multiple form elements (inputs, selects, checkboxes, radios) at once. ALWAYS prefer this tool over multiple individual 'fill' or 'click' calls when interacting with forms. It is significantly faster, more reliable, and reduces turn count. Example: Fill username, password, and check \"Remember Me\" in one call.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "elements": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "uid": {
                "type": "string",
                "description": "The uid of the element to fill out"
              },
              "value": {
                "type": "string",
                "description": "Value for the element. \"true\" or \"false\" for checkboxes and toggles, \"true\" for radio buttons."
              }
            },
            "required": [
              "uid",
              "value"
            ],
            "description": "An element to fill out",
            "additionalProperties": false
          },
          "description": "Elements from snapshot to fill out."
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "elements"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "press_key",
    "description": "Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A key or a combination (e.g., \"Enter\", \"Control+A\", \"Control++\", \"Control+Shift+R\"). Modifiers: Control, Shift, Alt, Meta"
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "type_text",
    "description": "Type text using keyboard into a previously focused input",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "The text to type"
        },
        "submitKey": {
          "description": "Optional key to press after typing. E.g., \"Enter\", \"Tab\", \"Escape\"",
          "type": "string"
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "hover",
    "description": "Hover over the provided element",
    "inputSchema": {
      "type": "object",
      "properties": {
        "uid": {
          "type": "string",
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "uid"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "wait_for",
    "description": "Wait for the specified text to appear on the selected page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "text": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Non-empty list of texts. Resolves when any value appears on the page."
        },
        "timeout": {
          "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used.",
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "handle_dialog",
    "description": "If a browser dialog was opened, use this command to handle it",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "accept",
            "dismiss"
          ],
          "description": "Whether to dismiss or accept the dialog"
        },
        "promptText": {
          "description": "Optional prompt text to enter into the dialog.",
          "type": "string"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_console_messages",
    "description": "List all console messages for the target page since the last navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pageSize": {
          "description": "Maximum number of messages to return. When omitted, returns all messages.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "pageIdx": {
          "description": "Page number to return (0-based). When omitted, returns the first page.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "types": {
          "description": "Filter messages to only return messages of the specified resource types. When omitted or empty, returns all messages.",
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "log",
              "debug",
              "info",
              "error",
              "warn",
              "dir",
              "dirxml",
              "table",
              "trace",
              "clear",
              "startGroup",
              "startGroupCollapsed",
              "endGroup",
              "assert",
              "profile",
              "profileEnd",
              "count",
              "timeEnd",
              "verbose",
              "issue"
            ]
          }
        },
        "includePreservedMessages": {
          "description": "Set to true to return the preserved messages over the last 3 navigations.",
          "default": false,
          "type": "boolean"
        },
        "includeStackTraces": {
          "description": "Set to true to include the stack trace for each message when available. Increases the response size.",
          "default": false,
          "type": "boolean"
        },
        "serviceWorkerId": {
          "description": "Filter messages to only return messages of the specified service worker.",
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "get_console_message",
    "description": "Gets a console message by its ID. You can get all messages by calling list_console_messages.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "msgid": {
          "type": "number",
          "description": "The msgid of a console message on the page from the listed console messages"
        }
      },
      "required": [
        "msgid"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_network_requests",
    "description": "Lists the most recent requests for the target page since the last navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pageSize": {
          "description": "Maximum number of requests to return. When omitted, returns all requests.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "pageIdx": {
          "description": "Page number to return (0-based). When omitted, returns the first page.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "resourceTypes": {
          "description": "Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.",
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "document",
              "stylesheet",
              "image",
              "media",
              "font",
              "script",
              "texttrack",
              "xhr",
              "fetch",
              "prefetch",
              "eventsource",
              "websocket",
              "manifest",
              "signedexchange",
              "ping",
              "cspviolationreport",
              "preflight",
              "fedcm",
              "other"
            ]
          }
        },
        "includePreservedRequests": {
          "description": "Set to true to return the preserved requests over the last 3 navigations.",
          "default": false,
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "get_network_request",
    "description": "Gets a network request by an optional reqid, if omitted returns the currently selected request in the DevTools Network panel. Useful for inspecting request headers (including 'Cookie') and response headers (including 'Set-Cookie' and directives).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "reqid": {
          "description": "The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.",
          "type": "number"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "evaluate_script",
    "description": "Evaluate a JavaScript function inside the target page. Returns the response as JSON, so returned values have to be JSON-serializable.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "function": {
          "type": "string",
          "description": "A JavaScript function declaration to be executed by the tool in the target page.\nExample without arguments: `() => document.title` or `async () => await fetch(\"example.com\")`.\nExample with arguments: `(el) => el.innerText`\n"
        },
        "args": {
          "description": "An optional list of arguments to pass to the function.",
          "type": "array",
          "items": {
            "type": "string",
            "description": "The uid of an element on the page from the page content snapshot"
          }
        },
        "dialogAction": {
          "description": "Handle dialogs while execution. \"accept\", \"dismiss\", or string for response of window.prompt. Defaults to accept.",
          "type": "string"
        },
        "waitForStableDom": {
          "description": "Whether to wait for the DOM to settle. Pass false if the script only reads data. Defaults to true.",
          "type": "boolean"
        }
      },
      "required": [
        "function"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "emulate",
    "description": "Emulates various features on the target page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "networkConditions": {
          "description": "Throttle network. Omit to disable throttling.",
          "type": "string",
          "enum": [
            "Offline",
            "Slow 3G",
            "Fast 3G",
            "Slow 4G",
            "Fast 4G"
          ]
        },
        "cpuThrottlingRate": {
          "description": "Represents the CPU slowdown factor. Omit or set the rate to 1 to disable throttling",
          "type": "number",
          "minimum": 1,
          "maximum": 20
        },
        "geolocation": {
          "description": "Geolocation (`<latitude>,<longitude>`) to emulate. Latitude between -90 and 90. Longitude between -180 and 180. Omit to clear the geolocation override.",
          "type": "string"
        },
        "userAgent": {
          "description": "User agent to emulate. Set to empty string to clear the user agent override.",
          "type": "string"
        },
        "colorScheme": {
          "description": "Emulate the dark or the light mode. Set to \"auto\" to reset to the default.",
          "type": "string",
          "enum": [
            "dark",
            "light",
            "auto"
          ]
        },
        "viewport": {
          "description": "Emulate device viewports '<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]'. 'touch' and 'mobile' to emulate mobile devices. 'landscape' to emulate landscape mode.",
          "type": "string"
        },
        "extraHttpHeaders": {
          "description": "Extra HTTP headers as a JSON string object, e.g. {\"X-Custom\": \"value\", \"Authorization\": \"Bearer token\"}. Headers are included into every HTTP request originating from the page and persist across navigations until cleared. Pass an empty string to clear all extra headers.",
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "resize_page",
    "description": "Resizes the page's window so that the page has specified dimension",
    "inputSchema": {
      "type": "object",
      "properties": {
        "width": {
          "type": "number",
          "description": "Page width"
        },
        "height": {
          "type": "number",
          "description": "Page height"
        }
      },
      "required": [
        "width",
        "height"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_css_styles",
    "description": "Retrieve matched CSS rules, inline styles, inherited styles, and cascade information for an element identified by its UID.\nUse this tool to debug why specific CSS properties are applied, overridden, or conflicting. Results are paginated and return 10 rules per page by default; use pageIdx to page through the remaining rules. Requires a UID from take_snapshot.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "uid": {
          "type": "string",
          "description": "The uid of the element on the page from the page content snapshot to inspect CSS styles for"
        },
        "pageSize": {
          "default": 10,
          "description": "Maximum number of CSS rules to return per page. Defaults to 10.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "pageIdx": {
          "default": 0,
          "description": "Page number to return (0-based). Defaults to 0 (the first page).",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "uid"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "lighthouse_audit",
    "description": "Get Lighthouse score and reports for accessibility, SEO, best practices, and agentic browsing. This excludes performance. For performance audits, run performance_start_trace",
    "inputSchema": {
      "type": "object",
      "properties": {
        "mode": {
          "default": "navigation",
          "description": "\"navigation\" reloads & audits. \"snapshot\" analyzes current state.",
          "type": "string",
          "enum": [
            "navigation",
            "snapshot"
          ]
        },
        "device": {
          "default": "desktop",
          "description": "Device to emulate.",
          "type": "string",
          "enum": [
            "desktop",
            "mobile"
          ]
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "list_webmcp_tools",
    "description": "Lists all WebMCP tools the page exposes.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "execute_webmcp_tool",
    "description": "Executes a WebMCP tool exposed by the page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "toolName": {
          "type": "string",
          "description": "The name of the WebMCP tool to execute"
        },
        "input": {
          "description": "The JSON-stringified parameters to pass to the WebMCP tool",
          "type": "string"
        }
      },
      "required": [
        "toolName"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_pages",
    "description": "Get a list of pages open in the browser.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  }
] as readonly BrowserToolSpec[];
