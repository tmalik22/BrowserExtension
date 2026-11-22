/**
 * Prompt templates CaptchaKraken v1.2 was trained on (verbatim from the model repo's prompts.json).
 * Coordinates are normalized 0-1000; the extension maps them back to the viewport.
 */
export const ACTION_PROMPT = `Your task is to solve the captcha. Read the instruction at the top of the image carefully.

Look at the puzzle and decide what action solves it. All coordinates you return must be on a normalized 0–1000 image scale (top-left = (0, 0), bottom-right = (1000, 1000)).

Name WHAT each object is with a short 1–2 word label, then give its position. Choose ONE response:

FOR CLICK PUZZLES:
  Label each thing you click and give its point — subjects[i] names points[i]:
  → "action": "click", "subjects": ["<label>", ...], "points": [[x1, y1], [x2, y2], ...]

FOR DRAG PUZZLES:
  Drag ONE item at a time. Label the source (the piece you pick up) and the destination (where it belongs), each with a short 1–2 word label, and give both points:
  → "action": "drag", "drags": [{ "source": "<label>", "from": [x, y], "destination": "<label>", "to": [x, y] }, ...]

FOR PUZZLE PIECE SLIDER PUZZLES:
  A single jigsaw piece has to end up in the piece-shaped slot cut into the picture. Do not pick up the piece or the slider handle — leave the source EMPTY and give only the destination, the CENTER OF THE SLOT the piece belongs in:
  → "action": "drag", "drags": [{ "source": "", "from": [], "destination": "<label>", "to": [x, y] }]

Respond ONLY with JSON:
{
  "goal": "What you see and what action you are taking and why",
  "action": "click", "subjects": [ ... ], "points": [ ... ]
  // OR "action": "drag", "drags": [ ... ]
}`;

export const TEXT_PROMPT = `Your task is to solve the captcha. The image shows a short code drawn in distorted, overlapping or warped characters, sometimes over a busy background.

Read the code exactly as printed. Preserve letter case when the characters clearly show it, and do not add spaces the image does not show. Decoration — strike-through lines, dots, blobs, background texture — is not part of the code.

Respond ONLY with JSON:
{
  "action": "type", "text": "<the code>"
}`;

const GRID_HINT: Record<number, string> = {
  3: `Hint: Separate images. Select only clear matches.

A cell that is already selected — small checkmark badge, border or highlight — still counts. Include it if it matches.

A cell being REPLACED does not: a large checkmark over the middle of the picture, a picture fading to white, or a new picture fading in. That cell is on its way to showing something else, so leave it out however well it matches.

If no cells match the description, return an empty list for target_ids: [].

Return JSON Array: [list of cell numbers (1-9)]`,
  4: `Hint: Single large image split into tiles. Select ALL parts.

A cell that is already selected — small checkmark badge, border or highlight — still counts. Include it if it matches.

A cell being REPLACED does not: a large checkmark over the middle of the picture, a picture fading to white, or a new picture fading in. That cell is on its way to showing something else, so leave it out however well it matches.

If no cells match the description, return an empty list for target_ids: [].

Return JSON Array: [list of cell numbers (1-16)]`,
};

/** Grid prompt for a 3x3 or 4x4 board (the screenshot already carries cell numbers). */
export function gridPrompt(size: number): string {
  const n = size === 4 ? 16 : 9;
  return `Solve the captcha grid by choosing the cell numbers that match the description from the captcha image prompt.

Grid: ${size}x${size} (${n} cells)
${GRID_HINT[size] ?? GRID_HINT[3]}`;
}

export const CAPTCHA_SYSTEM = 'You are a CAPTCHA solver. Follow the instruction exactly and respond with JSON only.';
