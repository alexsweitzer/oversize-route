const https = require('https');
const fs    = require('fs');
const path  = require('path');

/**
 * Reads text content from a permit file (PDF or image path).
 * Falls back gracefully if pdf-parse is unavailable or file is an image.
 */
async function extractPermitText(permit) {
  // If no local file path, just return the filename as context
  if (!permit.file_url || permit.file_url.startsWith('http')) {
    return `Permit file: ${permit.file_name} (State: ${permit.state_code}) — file stored remotely, use state routing standards`;
  }

  const localPath = path.join(__dirname, '../../', permit.file_url);
  const ext = path.extname(permit.file_name).toLowerCase();

  try {
    if (ext === '.pdf' && fs.existsSync(localPath)) {
      const pdfParse = require('pdf-parse');
      const buffer   = fs.readFileSync(localPath);
      const data     = await pdfParse(buffer);
      // Truncate to 2000 chars per permit to stay within token limits
      const text = data.text.replace(/\s+/g, ' ').trim().slice(0, 2000);
      return `=== ${permit.state_code} PERMIT: ${permit.file_name} ===\n${text}\n`;
    }
  } catch (e) {
    console.warn(`Could not parse permit PDF ${permit.file_name}:`, e.message);
  }

  // Image permit or parse failure — return metadata only
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
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = await makeAnthropicRequest(body);
  const clean = responseText.replace(/```json|```/g, '').trim();
  const analysis = JSON.parse(clean);

  if (!analysis.steps || !Array.isArray(analysis.steps)) {
    throw new Error('AI returned invalid steps array');
  }

  // Waypoints start as null — Google Maps resolves them on the frontend
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
