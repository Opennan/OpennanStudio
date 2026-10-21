// Built-in graphics templates (phase 10d): ids, names, and parameters of the graphics clips OpenNan creates, so
// projects made there (and MCP add_graphics_clip) render here. Drawn by draw/*.ts; metadata only in this module.
import type { GraphicsTemplateDef } from "./types";

/** Template frame rate: graphics animate on a 30 fps grid in the preview and both exports. */
export const GRAPHICS_FPS = 30;

export const GRAPHICS_TEMPLATES: readonly GraphicsTemplateDef[] = [
    {
        "id": "animated-title",
        "name": "Animated Title",
        "category": "text",
        "description": "Large title with spring word-by-word entrance and optional subtitle.",
        "params": [
            {
                "key": "title",
                "label": "Title",
                "type": "text",
                "default": "Your Title"
            },
            {
                "key": "subtitle",
                "label": "Subtitle",
                "type": "text",
                "default": ""
            },
            {
                "key": "color",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "accentColor",
                "label": "Accent color",
                "type": "color",
                "default": "#7c3aed"
            },
            {
                "key": "align",
                "label": "Alignment",
                "type": "select",
                "default": "center",
                "options": [
                    "left",
                    "center",
                    "right"
                ]
            },
            {
                "key": "speed",
                "label": "Animation speed",
                "type": "number",
                "default": 1,
                "min": 0.25,
                "max": 3,
                "step": 0.25
            }
        ]
    },
    {
        "id": "lower-third",
        "name": "Lower Third",
        "category": "text",
        "description": "Name and role bar sliding in from the left at the lower third.",
        "params": [
            {
                "key": "name",
                "label": "Name",
                "type": "text",
                "default": "Name Surname"
            },
            {
                "key": "role",
                "label": "Role",
                "type": "text",
                "default": "Title, Company"
            },
            {
                "key": "barColor",
                "label": "Bar color",
                "type": "color",
                "default": "#7c3aed"
            },
            {
                "key": "textColor",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "speed",
                "label": "Animation speed",
                "type": "number",
                "default": 1,
                "min": 0.25,
                "max": 3,
                "step": 0.25
            }
        ]
    },
    {
        "id": "caption-pop",
        "name": "Caption Pop",
        "category": "text",
        "description": "Short punchy caption that pops in with a spring scale, centered low.",
        "params": [
            {
                "key": "text",
                "label": "Caption",
                "type": "text",
                "default": "WAIT FOR IT"
            },
            {
                "key": "color",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "bgColor",
                "label": "Pill color",
                "type": "color",
                "default": "#111111"
            },
            {
                "key": "size",
                "label": "Size",
                "type": "number",
                "default": 64,
                "min": 24,
                "max": 160,
                "step": 4
            },
            {
                "key": "position",
                "label": "Position",
                "type": "select",
                "default": "lower_third",
                "options": [
                    "lower_third",
                    "bottom",
                    "center",
                    "top"
                ]
            },
            {
                "key": "safeBottom",
                "label": "Letterbox bar %",
                "type": "number",
                "default": 0,
                "min": 0,
                "max": 45,
                "step": 1
            }
        ]
    },
    {
        "id": "bar-chart",
        "name": "Bar Chart",
        "category": "data",
        "description": "Animated horizontal bar chart growing from zero with labels and values.",
        "params": [
            {
                "key": "title",
                "label": "Chart title",
                "type": "text",
                "default": "Monthly Sales"
            },
            {
                "key": "data",
                "label": "Data",
                "type": "json",
                "default": "[{\"label\": \"Jan\", \"value\": 40}, {\"label\": \"Feb\", \"value\": 65}, {\"label\": \"Mar\", \"value\": 90}]"
            },
            {
                "key": "barColor",
                "label": "Bar color",
                "type": "color",
                "default": "#7c3aed"
            },
            {
                "key": "textColor",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            }
        ]
    },
    {
        "id": "countdown",
        "name": "Countdown",
        "category": "utility",
        "description": "Big digits counting down to zero with a pulse on each second.",
        "params": [
            {
                "key": "from",
                "label": "Count from",
                "type": "number",
                "default": 5,
                "min": 1,
                "max": 60,
                "step": 1
            },
            {
                "key": "color",
                "label": "Digit color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "accentColor",
                "label": "Ring color",
                "type": "color",
                "default": "#7c3aed"
            }
        ]
    },
    {
        "id": "progress-bar",
        "name": "Progress Bar",
        "category": "utility",
        "description": "Thin progress bar filling across the clip duration with a percentage label.",
        "params": [
            {
                "key": "label",
                "label": "Label",
                "type": "text",
                "default": ""
            },
            {
                "key": "barColor",
                "label": "Bar color",
                "type": "color",
                "default": "#7c3aed"
            },
            {
                "key": "trackColor",
                "label": "Track color",
                "type": "color",
                "default": "#333333"
            },
            {
                "key": "position",
                "label": "Position",
                "type": "select",
                "default": "bottom",
                "options": [
                    "top",
                    "bottom"
                ]
            }
        ]
    },
    {
        "id": "logo-sting",
        "name": "Logo Sting",
        "category": "brand",
        "description": "Logo image scaling in with a spring, then a shine sweep.",
        "params": [
            {
                "key": "logoUrl",
                "label": "Logo image URL",
                "type": "text",
                "default": ""
            },
            {
                "key": "text",
                "label": "Brand text",
                "type": "text",
                "default": "Your Brand"
            },
            {
                "key": "color",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "bgColor",
                "label": "Background",
                "type": "color",
                "default": "transparent"
            }
        ]
    },
    {
        "id": "card",
        "name": "Intro / Outro Card",
        "category": "scene",
        "description": "Full-frame gradient card with headline and subline — for intros, outros, chapter breaks.",
        "params": [
            {
                "key": "headline",
                "label": "Headline",
                "type": "text",
                "default": "Chapter One"
            },
            {
                "key": "subline",
                "label": "Subline",
                "type": "text",
                "default": ""
            },
            {
                "key": "fromColor",
                "label": "Gradient from",
                "type": "color",
                "default": "#1e1b4b"
            },
            {
                "key": "toColor",
                "label": "Gradient to",
                "type": "color",
                "default": "#7c3aed"
            },
            {
                "key": "textColor",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            }
        ]
    },
    {
        "id": "subscribe-button",
        "name": "Subscribe Button",
        "category": "social",
        "description": "Subscribe call-to-action that pops in, pulses on a click, and shakes the bell.",
        "params": [
            {
                "key": "text",
                "label": "Button text",
                "type": "text",
                "default": "SUBSCRIBE"
            },
            {
                "key": "buttonColor",
                "label": "Button color",
                "type": "color",
                "default": "#ff0033"
            },
            {
                "key": "textColor",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "position",
                "label": "Position",
                "type": "select",
                "default": "bottom",
                "options": [
                    "bottom",
                    "center",
                    "top"
                ]
            },
            {
                "key": "showBell",
                "label": "Bell icon",
                "type": "select",
                "default": "yes",
                "options": [
                    "yes",
                    "no"
                ]
            }
        ]
    },
    {
        "id": "social-handle",
        "name": "Social Handle",
        "category": "social",
        "description": "Platform badge with your @handle sliding in from a corner.",
        "params": [
            {
                "key": "handle",
                "label": "Handle",
                "type": "text",
                "default": "@yourname"
            },
            {
                "key": "platform",
                "label": "Platform",
                "type": "select",
                "default": "youtube",
                "options": [
                    "youtube",
                    "tiktok",
                    "instagram",
                    "x"
                ]
            },
            {
                "key": "bgColor",
                "label": "Badge color",
                "type": "color",
                "default": "#111111"
            },
            {
                "key": "textColor",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "corner",
                "label": "Corner",
                "type": "select",
                "default": "bottom_left",
                "options": [
                    "bottom_left",
                    "bottom_right",
                    "top_left",
                    "top_right"
                ]
            }
        ]
    },
    {
        "id": "arrow-callout",
        "name": "Arrow Callout",
        "category": "callout",
        "description": "Bouncing arrow pointing at a spot in the video with an optional label.",
        "params": [
            {
                "key": "label",
                "label": "Label",
                "type": "text",
                "default": "Look here"
            },
            {
                "key": "x",
                "label": "Target X (0-1)",
                "type": "number",
                "default": 0.5,
                "min": 0,
                "max": 1,
                "step": 0.01
            },
            {
                "key": "y",
                "label": "Target Y (0-1)",
                "type": "number",
                "default": 0.5,
                "min": 0,
                "max": 1,
                "step": 0.01
            },
            {
                "key": "direction",
                "label": "Arrow points",
                "type": "select",
                "default": "down",
                "options": [
                    "down",
                    "up",
                    "left",
                    "right"
                ]
            },
            {
                "key": "color",
                "label": "Color",
                "type": "color",
                "default": "#f59e0b"
            },
            {
                "key": "textColor",
                "label": "Label text color",
                "type": "color",
                "default": "#111111"
            }
        ]
    },
    {
        "id": "highlight-spot",
        "name": "Highlight Spot",
        "category": "callout",
        "description": "Pulsing circle or box that draws attention to a spot, with optional background dim.",
        "params": [
            {
                "key": "x",
                "label": "Center X (0-1)",
                "type": "number",
                "default": 0.5,
                "min": 0,
                "max": 1,
                "step": 0.01
            },
            {
                "key": "y",
                "label": "Center Y (0-1)",
                "type": "number",
                "default": 0.5,
                "min": 0,
                "max": 1,
                "step": 0.01
            },
            {
                "key": "size",
                "label": "Size (% of width)",
                "type": "number",
                "default": 22,
                "min": 5,
                "max": 80,
                "step": 1
            },
            {
                "key": "shape",
                "label": "Shape",
                "type": "select",
                "default": "circle",
                "options": [
                    "circle",
                    "box"
                ]
            },
            {
                "key": "color",
                "label": "Color",
                "type": "color",
                "default": "#f59e0b"
            },
            {
                "key": "dimBackground",
                "label": "Dim background",
                "type": "select",
                "default": "no",
                "options": [
                    "no",
                    "yes"
                ]
            }
        ]
    },
    {
        "id": "line-chart",
        "name": "Line Chart",
        "category": "data",
        "description": "Line chart that draws itself left to right with value dots and labels.",
        "params": [
            {
                "key": "title",
                "label": "Chart title",
                "type": "text",
                "default": "Growth"
            },
            {
                "key": "data",
                "label": "Data",
                "type": "json",
                "default": "[{\"label\": \"Q1\", \"value\": 20}, {\"label\": \"Q2\", \"value\": 45}, {\"label\": \"Q3\", \"value\": 38}, {\"label\": \"Q4\", \"value\": 80}]"
            },
            {
                "key": "lineColor",
                "label": "Line color",
                "type": "color",
                "default": "#7c3aed"
            },
            {
                "key": "textColor",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            }
        ]
    },
    {
        "id": "donut-chart",
        "name": "Donut Chart",
        "category": "data",
        "description": "Donut chart sweeping in clockwise with a legend and center label.",
        "params": [
            {
                "key": "title",
                "label": "Chart title",
                "type": "text",
                "default": "Market Share"
            },
            {
                "key": "data",
                "label": "Data",
                "type": "json",
                "default": "[{\"label\": \"Product A\", \"value\": 45}, {\"label\": \"Product B\", \"value\": 30}, {\"label\": \"Other\", \"value\": 25}]"
            },
            {
                "key": "centerLabel",
                "label": "Center label",
                "type": "text",
                "default": "2026"
            },
            {
                "key": "textColor",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            }
        ]
    },
    {
        "id": "stat-counter",
        "name": "Stat Counter",
        "category": "data",
        "description": "Big number counting up to a value with prefix, suffix, and label.",
        "params": [
            {
                "key": "value",
                "label": "Value",
                "type": "number",
                "default": 1000000,
                "min": 0,
                "max": 1000000000,
                "step": 1
            },
            {
                "key": "prefix",
                "label": "Prefix",
                "type": "text",
                "default": ""
            },
            {
                "key": "suffix",
                "label": "Suffix",
                "type": "text",
                "default": "+"
            },
            {
                "key": "label",
                "label": "Label",
                "type": "text",
                "default": "Happy customers"
            },
            {
                "key": "color",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "accentColor",
                "label": "Accent color",
                "type": "color",
                "default": "#7c3aed"
            }
        ]
    },
    {
        "id": "confetti-burst",
        "name": "Confetti Burst",
        "category": "shape",
        "description": "Celebration confetti particles bursting across the frame.",
        "params": [
            {
                "key": "count",
                "label": "Particles",
                "type": "number",
                "default": 80,
                "min": 10,
                "max": 200,
                "step": 5
            },
            {
                "key": "colors",
                "label": "Colors",
                "type": "json",
                "default": "[\"#7c3aed\", \"#06b6d4\", \"#f59e0b\", \"#ef4444\", \"#22c55e\"]"
            },
            {
                "key": "origin",
                "label": "Burst from",
                "type": "select",
                "default": "center",
                "options": [
                    "center",
                    "bottom",
                    "top"
                ]
            }
        ]
    },
    {
        "id": "shape-wipe",
        "name": "Shape Wipe",
        "category": "shape",
        "description": "Full-frame wipe stinger: covers the cut, then reveals the next shot.",
        "params": [
            {
                "key": "color",
                "label": "Wipe color",
                "type": "color",
                "default": "#111111"
            },
            {
                "key": "accentColor",
                "label": "Edge color",
                "type": "color",
                "default": "#7c3aed"
            },
            {
                "key": "style",
                "label": "Style",
                "type": "select",
                "default": "wipe",
                "options": [
                    "wipe",
                    "circle",
                    "split"
                ]
            },
            {
                "key": "direction",
                "label": "Direction",
                "type": "select",
                "default": "left_to_right",
                "options": [
                    "left_to_right",
                    "right_to_left",
                    "top_to_bottom",
                    "bottom_to_top"
                ]
            }
        ]
    },
    {
        "id": "gradient-backdrop",
        "name": "Gradient Backdrop",
        "category": "shape",
        "description": "Slowly drifting animated gradient background for full-frame sections.",
        "params": [
            {
                "key": "colorA",
                "label": "Color A",
                "type": "color",
                "default": "#1e1b4b"
            },
            {
                "key": "colorB",
                "label": "Color B",
                "type": "color",
                "default": "#7c3aed"
            },
            {
                "key": "angle",
                "label": "Angle",
                "type": "number",
                "default": 135,
                "min": 0,
                "max": 360,
                "step": 5
            },
            {
                "key": "speed",
                "label": "Drift speed",
                "type": "number",
                "default": 1,
                "min": 0.25,
                "max": 3,
                "step": 0.25
            }
        ]
    },
    {
        "id": "typewriter-text",
        "name": "Typewriter Text",
        "category": "text",
        "description": "Text typing on character by character with a blinking caret.",
        "params": [
            {
                "key": "text",
                "label": "Text",
                "type": "text",
                "default": "Type something great..."
            },
            {
                "key": "color",
                "label": "Text color",
                "type": "color",
                "default": "#ffffff"
            },
            {
                "key": "bgColor",
                "label": "Background",
                "type": "color",
                "default": "transparent"
            },
            {
                "key": "size",
                "label": "Size",
                "type": "number",
                "default": 54,
                "min": 24,
                "max": 140,
                "step": 2
            },
            {
                "key": "speed",
                "label": "Chars per second",
                "type": "number",
                "default": 14,
                "min": 2,
                "max": 40,
                "step": 1
            },
            {
                "key": "position",
                "label": "Position",
                "type": "select",
                "default": "center",
                "options": [
                    "center",
                    "lower_third",
                    "top"
                ]
            }
        ]
    }
];
