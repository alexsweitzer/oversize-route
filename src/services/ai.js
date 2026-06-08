const https = require('https');

/**
 * Calls the Anthropic API to analyze permit data and generate a
 * permit-compliant turn-by-turn route.
 *
 * @param {Object} route    - Route record from database
 * @param {Array}  permits  - Permit records from database
 * @returns {Object}        - Analysis result with steps, waypoints, alerts
 */
async function analyzePermitsWithAI(route, permits) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set in environment');
  }

  const permitSummary = permits.map(p =>
    `- ${p.state_code}: ${p.file_name} (${p.status})`
  ).join('\n');

  const prompt = `You are an oversized load routing expert for a trucking company.
Analyze this trip and generate a permit-compliant route.

TRIP DETAILS:
- Origin: ${route.origin_address}
- Destination: ${route.dest_address}
- Load: ${route.load_description || 'Oversized load'} ${route.load_width ? `(${route.load_width} wide)` : ''}
- Permits on file:
${permitSummary || '  (no permits uploaded yet — use general oversized routing)'}

Return ONLY a JSON object (no markdown, no preamble):
{
  "distance_mi": 487.2,
  "duration_min": 585,
  "states": ["TX", "LA"],
  "steps": [
    {
      "icon": "🚦",
      "arrow": "⬆",
      "dir": "straight",
      "text": "Depart [full origin address] heading [direction] on [road name]",
      "note": "",
      "dist": 0.4,
      "permit": ""
    }
  ],
  "alerts": [
    {
      "state": "TX",
      "message": "Daytime travel only between 7AM and 8PM on TX-225 and US-90 ALT"
    }
  ]
}

Rules for steps:
- 8 to 14 steps total
- dir must be one of: straight, right, left, merge, exit, arrive
- arrow must be one of: ⬆, →, ←, ↗, ↙, 🏁
- note = short permit restriction flag (or empty string)
- permit = full permit restriction sentence (or empty string)
- dist = miles for this segment as a number
- Make routes realistic for the actual geography of the origin/destination
- Include mandatory permit waypoints that differ from normal GPS routing
- Last step must have dir "arrive" and dist 0`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = await makeAnthropicRequest(body);

  // Parse the JSON from Claude's response
  const clean = responseText.replace(/```json|```/g, '').trim();
  const analysis = JSON.parse(clean);

  // Validate required fields
  if (!analysis.steps || !Array.isArray(analysis.steps)) {
    throw new Error('AI returned invalid steps array');
  }

  // Build waypoints array from steps (lat/lng will be null — Google Maps fills these in on the frontend)
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { analyzePermitsWithAI };
