const https = require('https');
const fs    = require('fs');
const path  = require('path');

/**
 * Extract full text from a permit PDF using pdf-parse.
 * No truncation — we need the complete routing table.
 */
async function extractPermitText(permit) {
  if (!permit.file_url || permit.file_url.startsWith('http')) {
    return { state: permit.state_code, text: '', note: 'remote file — no text' };
  }
  const projectRoot  = path.join(__dirname, '../../');
  const relativePath = permit.file_url.replace(/^\//, '');
  const localPath    = path.join(projectRoot, relativePath);
  const ext          = path.extname(permit.file_name).toLowerCase();

  try {
    if (!fs.existsSync(localPath)) {
      console.warn(`Permit file not found: ${localPath}`);
      return { state: permit.state_code, text: '', note: 'file not found' };
    }
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const buffer   = fs.readFileSync(localPath);
      const data     = await pdfParse(buffer);
      // NO truncation — full text so the entire routing table is captured
      const text = data.text.replace(/\r/g, '').trim();
      console.log(`Permit ${permit.state_code} (${permit.file_name}): extracted ${text.length} chars`);
      return { state: permit.state_code, text, note: 'ok' };
    }
    return { state: permit.state_code, text: '', note: 'image — no text extraction' };
  } catch (e) {
    console.warn(`Could not parse permit ${permit.file_name}:`, e.message);
    return { state: permit.state_code, text: '', note: 'parse error: ' + e.message };
  }
}

/**
 * STAGE 1: Extract structured route legs from all permits.
 * Each leg = { road, direction, from, to, state, notes }
 * These are the exact roads the driver is legally required to follow.
 */
async function extractRouteLegs(route, permits) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  // Read all permit texts (full, untruncated)
  const permitData = await Promise.all(permits.map(p => extractPermitText(p)));

  // Build the permit content block, labeled by state
  const permitBlock = permitData
    .filter(p => p.text)
    .map(p => `########## ${p.state} PERMIT ##########\n${p.text}`)
    .join('\n\n');

  const prompt = `Extract the exact legally-required route from these oversized-load permits. Output compact JSON only.

TRIP: ${route.origin_address} → ${route.dest_address}

PERMITS:
${permitBlock}

Each permit has an authorized route (ordered highways/exits the driver MUST follow). Find it:
- OHIO: "Via" line or ROUTING table
- PA: "Authorized Route" leg table
- MD: "Authorized Route:" line
- WV: route description (START...END)
- MI: "Directions:" line

Order legs in travel sequence (MD→WV→PA→OH→MI). Extract EVERY road segment exactly.

Output ONLY this JSON (no markdown):
{
"states_in_order":["MD","WV","PA","OH","MI"],
"legs":[
{"seq":1,"state":"MD","road":"MD-8","direction":"N","to":"US-50 Exit 37","raw":"MD-8 NB(EMORY CIR)"}
],
"permit_start":"MD-8 at Emory Cir, Stevensville MD",
"permit_end":"US-10 at Mason MP9.37, Ludington MI",
"alerts":[{"state":"MD","message":"Notify Bay Bridge 410-537-7911 1hr prior"}]
}

Rules: road=exact designation (I-70,US-40,SR-149,MD-8). direction=N/S/E/W. to=exit/milepost where leg ends. raw=exact permit text. Be exhaustive — every segment.`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = await makeAnthropicRequest(body);
  let clean = responseText.replace(/```json|```/g, '').trim();
  const first = clean.indexOf('{');
  const last  = clean.lastIndexOf('}');
  if (first !== -1 && last !== -1) clean = clean.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error('Leg extraction JSON parse failed. Length:', responseText.length);
    console.error('Tail:', clean.slice(-300));
    throw new Error('Permit route extraction returned incomplete JSON — try again');
  }

  if (!parsed.legs || !Array.isArray(parsed.legs)) {
    throw new Error('Extraction returned no legs array');
  }

  console.log(`Extracted ${parsed.legs.length} route legs across states: ${parsed.states_in_order?.join(',')}`);
  return parsed;
}

/**
 * Main entry — extract the exact permit route legs.
 * Returns structured legs that the geometry stage will trace onto roads.
 */
async function analyzePermitsWithAI(route, permits) {
  const extraction = await extractRouteLegs(route, permits);

  // Convert legs into turn-by-turn steps for the driver display
  const steps = legsToSteps(extraction, route);

  return {
    legs:         extraction.legs,
    states:       extraction.states_in_order || [],
    permit_start: extraction.permit_start || '',
    permit_end:   extraction.permit_end || '',
    alerts:       extraction.alerts || [],
    steps,
    // waypoints derived later by geometry stage
    waypoints: steps.map(() => ({ lat: null, lng: null })),
  };
}

/**
 * Turn structured legs into driver-facing turn-by-turn steps.
 */
function legsToSteps(extraction, route) {
  const steps = [];

  // Step 1: depart true origin (connector to permit start)
  steps.push({
    icon: '🚦', arrow: '⬆', dir: 'straight',
    text: `Depart ${route.origin_address}`,
    note: `Auto-route to permit start: ${extraction.permit_start || 'first permit road'}`,
    dist: 0, permit: '', location: '',
  });

  // Middle steps: one per permit leg
  extraction.legs.forEach((leg, i) => {
    const dirWord = { N:'North', S:'South', E:'East', W:'West' }[leg.direction] || '';
    const arrow   = { N:'⬆', S:'⬇', E:'➡️', W:'⬅️' }[leg.direction] || '➡️';
    steps.push({
      icon: '🛣️', arrow, dir: guessDir(leg),
      text: `${leg.road}${dirWord ? ' ' + dirWord : ''}${leg.to ? ' → ' + leg.to : ''}`,
      note: leg.raw || '',
      dist: 0, permit: '', location: `${leg.state}`,
      leg_ref: leg.seq,
    });
  });

  // Final step: arrive at true destination (connector from permit end)
  steps.push({
    icon: '🏁', arrow: '🏁', dir: 'arrive',
    text: `Arrive at ${route.dest_address}`,
    note: `Auto-route from permit end: ${extraction.permit_end || 'last permit road'}`,
    dist: 0, permit: 'Permit route complete', location: '',
  });

  return steps;
}

function guessDir(leg) {
  const r = (leg.raw || '').toLowerCase();
  if (r.includes('turn right') || r.includes('right onto')) return 'right';
  if (r.includes('turn left')  || r.includes('left onto'))  return 'left';
  if (r.includes('merge') || r.includes('ramp'))            return 'merge';
  if (r.includes('exit'))                                    return 'exit';
  return 'straight';
}

function makeAnthropicRequest(body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-api-key':        process.env.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01',
        'Content-Length':   Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(`Anthropic API error: ${parsed.error.message}`));
          else resolve(parsed.content?.map(b => b.text || '').join('') || '');
        } catch (e) {
          reject(new Error('Failed to parse Anthropic response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(280000, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { analyzePermitsWithAI, extractRouteLegs, extractPermitText };
