const https = require('https');
const fs    = require('fs');
const path  = require('path');

/**
 * Reads text content from a permit file (PDF or image path).
 * Falls back gracefully if pdf-parse is unavailable or file is an image.
 */
async function extractPermitText(permit) {
  // Remote file (S3/R2) — can't read server-side, use filename as context
  if (!permit.file_url || permit.file_url.startsWith('http')) {
    console.log(`Permit ${permit.file_name}: remote file, using filename context only`);
    return `Permit file: ${permit.file_name} (State: ${permit.state_code}) — apply standard ${permit.state_code} OSOW routing rules`;
  }

  // Local file — file_url is like "/uploads/1234567890-KM_OH.pdf"
  // Resolve from project root (two levels up from src/services/)
  const projectRoot = path.join(__dirname, '../../');
  // Strip leading slash from file_url before joining
  const relativePath = permit.file_url.replace(/^\//, '');
  const localPath = path.join(projectRoot, relativePath);

  console.log(`Permit ${permit.file_name}: reading from ${localPath}`);

  const ext = path.extname(permit.file_name).toLowerCase();

  try {
    if (!fs.existsSync(localPath)) {
      console.warn(`Permit file not found at: ${localPath}`);
      return `Permit on file: ${permit.file_name} (State: ${permit.state_code}) — file not found, apply standard ${permit.state_code} OSOW routing rules`;
    }

    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const buffer   = fs.readFileSync(localPath);
      const data     = await pdfParse(buffer);
      const text     = data.text.replace(/\s+/g, ' ').trim().slice(0, 3000);
      console.log(`Permit ${permit.file_name}: extracted ${text.length} chars`);
      return `=== ${permit.state_code} PERMIT: ${permit.file_name} ===\n${text}\n`;
    }

    if (['.jpg','.jpeg','.png'].includes(ext)) {
      // Image permits — read as base64 and note it's an image
      console.log(`Permit ${permit.file_name}: image file, using filename context`);
      return `Permit image: ${permit.file_name} (State: ${permit.state_code}) — apply standard ${permit.state_code} OSOW routing rules`;
    }
  } catch (e) {
    console.warn(`Could not parse permit ${permit.file_name}:`, e.message);
  }

  return `Permit on file: ${permit.file_name} (State: ${permit.state_code}) — apply standard ${permit.state_code} OSOW routing rules`;
}

/**
 * Calls the Anthropic API to analyze permit content and generate a
 * permit-compliant turn-by-turn route.
 */
async function analyzePermitsWithAI(route, permits) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set in environment');
  }

  // Extract text from each permit file
  let permitContent = '';
  if (permits.length > 0) {
    const texts = await Promise.all(permits.map(p => extractPermitText(p)));
    permitContent = texts.join('\n');
  } else {
    permitContent = '(No permits uploaded — use general OSOW routing standards for each state)';
  }

  const prompt = `You are an oversized load (OSOW) routing expert for a commercial trucking company.
Your job is to read the actual permit documents provided and generate a route that strictly complies with every restriction listed in those permits.

TRIP DETAILS:
- Origin: ${route.origin_address}
- Destination: ${route.dest_address}
- Load description: ${route.load_description || 'Oversized load'} ${route.load_width ? `(${route.load_width} wide)` : ''}

PERMIT DOCUMENTS:
${permitContent}

INSTRUCTIONS:
1. Read every restriction in the permit documents above carefully
2. Identify mandatory routes, prohibited roads, required detours, escort requirements, time restrictions, and bridge/weight restrictions
3. Build the route to comply with ALL permit restrictions — do NOT use roads the permits prohibit
4. If permits specify exact roads to use, use those exact roads
5. If no permits are provided, use standard OSOW routing (avoid low bridges, weight-restricted roads, urban cores)
6. Include a permit alert for every restriction that affects the driver
7. The map_waypoints array is CRITICAL — list 4-8 specific cities along the EXACT permit-required route corridor in order from origin to destination. These must be geographically sensible — waypoints must progress logically toward the destination without backtracking or detouring. Format as "City, State" only (e.g. "Hagerstown, MD"). IMPORTANT: A permit for a state does not mean routing through the interior of that state — I-70 briefly crosses WV for only a few miles; do NOT add WV cities as waypoints unless the route genuinely travels deep into WV. Think about the actual highway geometry.

Return ONLY a valid JSON object (no markdown, no explanation, no preamble):
{
  "distance_mi": 487.2,
  "duration_min": 585,
  "states": ["MD", "WV", "PA", "OH"],
  "map_waypoints": [
    "Hagerstown, MD",
    "Morgantown, WV",
    "Wheeling, WV",
    "St. Clairsville, OH"
  ],
  "steps": [
    {
      "icon": "🚦",
      "arrow": "⬆",
      "dir": "straight",
      "text": "Depart [full origin address] heading [direction] on [road name]",
      "note": "",
      "dist": 0.4,
      "permit": "",
      "location": "Stevensville, MD"
    }
  ],
  "alerts": [
    {
      "state": "MD",
      "message": "Exact restriction from permit document"
    }
  ]
}

Step rules:
- 8 to 16 steps depending on route complexity
- dir: straight | right | left | merge | exit | arrive
- arrow: ⬆ | → | ← | ↗ | ↙ | 🏁
- note: brief permit flag shown on the step (empty string if none)
- permit: full permit restriction sentence (empty string if none)
- location: city and state where this step occurs (e.g. "Wheeling, WV")
- dist: miles as a decimal number
- Last step MUST have dir "arrive" and dist 0
- map_waypoints MUST reflect the actual permit-required route — if permits require I-70 through Wheeling WV, include "Wheeling, WV" as a waypoint
- Be specific — use real road names, highway numbers, and exit numbers`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = await makeAnthropicRequest(body);
  let clean = responseText.replace(/```json|```/g, '').trim();

  // Extract JSON object if there's any surrounding text
  const firstBrace = clean.indexOf('{');
  const lastBrace  = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    clean = clean.slice(firstBrace, lastBrace + 1);
  }

  let analysis;
  try {
    analysis = JSON.parse(clean);
  } catch (e) {
    console.error('JSON parse failed. Response length:', responseText.length);
    console.error('Last 200 chars:', clean.slice(-200));
    throw new Error('AI response was incomplete (likely truncated). Try again — the route may have been too complex for one response.');
  }

  if (!analysis.steps || !Array.isArray(analysis.steps)) {
    throw new Error('AI returned invalid steps array');
  }

  // Waypoints start as null — map resolves them on the frontend
  analysis.waypoints = analysis.steps.map(() => ({ lat: null, lng: null }));

  return analysis;
}

function makeAnthropicRequest(body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':          process.env.ANTHROPIC_API_KEY,
        'anthropic-version':  '2023-06-01',
        'Content-Length':     Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Anthropic API error: ${parsed.error.message}`));
          } else {
            const text = parsed.content?.map(b => b.text || '').join('') || '';
            resolve(text);
          }
        } catch (e) {
          reject(new Error('Failed to parse Anthropic response: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { analyzePermitsWithAI };
