import { defineAdapter } from '@nichedb/core/adapter';
import { toItem } from './ais.js';

/**
 * Ships worldwide, from aisstream.io.
 *
 * aisstream.io relays a volunteer receiver network's AIS over one WebSocket,
 * free with a key (the account is a GitHub sign-in). It is a stream, not an
 * API: nothing can be asked about a ship, you hear what ships say while you
 * listen. So a run subscribes to the whole world, listens for a fixed window,
 * keeps the newest of everything each MMSI said, and writes one row per
 * vessel -- the same rows `digitraffic-ais` writes, through the same `toItem`.
 *
 * WHY SIX AND A HALF MINUTES
 *
 * A ship sends its position every few seconds to three minutes, but its name,
 * type, size, IMO and destination (message 5, ShipStaticData; 24 for class B)
 * only every six minutes. A shorter window writes most ships without a type,
 * and because a row is rewritten whole, it would also wipe the type an earlier
 * run had learned. Listening past one static interval gives most ships both.
 *
 * TRAPS
 *
 * - The subscription must be sent within 3 s of opening or the socket closes;
 *   a bad key answers `{"error": ...}` and closes.
 * - Frames arrive as binary even though they are JSON text.
 * - Every message carries MetaData.ShipName, padded and sometimes empty, so a
 *   position report alone names most ships.
 * - Sog 102.3, Cog 360 and TrueHeading 511 mean "not available" (toItem knows).
 * - Draught arrives in metres here; toItem takes Digitraffic's decimetres.
 */

const URL_WS = 'wss://stream.aisstream.io/v0/stream';
const TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];

export const AISSTREAM_ORIGIN = {
  network: 'aisstream.io worldwide AIS receiver network',
  source: 'aisstream.io (free API key)',
  dataset: URL_WS,
};

const str = (v) => {
  const s = String(v ?? '')
    .replace(/@+$/, '')
    .trim();
  return s || null;
};

/** aisstream's "2026-11-11 05:25:46.689292372 +0000 UTC" as epoch ms. */
export function streamTime(s) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(String(s ?? ''));
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : null;
}

/** Fold one stream message into the per-vessel state. */
export function absorb(state, msg) {
  const meta = msg?.MetaData;
  const mmsi = Number(meta?.MMSI);
  if (!Number.isFinite(mmsi) || mmsi <= 0) return;
  const v = state.get(mmsi) ?? { mmsi, name: null, pos: null, stat: null, classB: null };
  v.name = str(meta.ShipName) ?? v.name;
  const body = msg.Message?.[msg.MessageType];
  if (!body) return state.set(mmsi, v);
  const at = streamTime(meta.time_utc) ?? Date.now();
  if (/PositionReport$/.test(msg.MessageType)) {
    const lat = Number(body.Latitude ?? meta.latitude);
    const lon = Number(body.Longitude ?? meta.longitude);
    // 91 / 181 are AIS's "no position".
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (!v.pos || at >= v.pos.at)) {
      v.pos = {
        at,
        lat,
        lon,
        sog: body.Sog,
        cog: body.Cog,
        heading: body.TrueHeading,
        navStat: body.NavigationalStatus ?? 15,
      };
    }
  } else if (msg.MessageType === 'ShipStaticData') {
    v.stat = {
      at,
      name: str(body.Name),
      callSign: str(body.CallSign),
      imo: Number(body.ImoNumber) || null,
      type: Number(body.Type) || null,
      destination: str(body.Destination),
      draughtM: Number(body.MaximumStaticDraught) || null,
      dim: body.Dimension ?? null,
    };
  } else if (msg.MessageType === 'StaticDataReport') {
    // Class B static data comes in two parts: A carries the name, B the rest.
    const a = body.ReportA;
    const b = body.ReportB;
    v.classB = { ...(v.classB ?? {}) };
    if (a?.Valid) v.classB.name = str(a.Name) ?? v.classB.name;
    if (b?.Valid) {
      v.classB.callSign = str(b.CallSign);
      v.classB.type = Number(b.ShipType) || null;
      v.classB.dim = b.Dimension ?? null;
    }
  }
  state.set(mmsi, v);
}

/** One vessel's state as the row `digitraffic-ais` would write. */
export function vesselItem(v) {
  const s = v.stat ?? {};
  const b = v.classB ?? {};
  const dim = s.dim ?? b.dim ?? {};
  const name = s.name ?? b.name ?? v.name;
  if (!name && !v.pos) return null;
  const register = {
    mmsi: v.mmsi,
    imo: s.imo ?? 0,
    name,
    callSign: s.callSign ?? b.callSign ?? null,
    shipType: s.type ?? b.type ?? 0,
    destination: s.destination ?? null,
    draught: s.draughtM ? Math.round(s.draughtM * 10) : 0,
    referencePointA: dim.A ?? 0,
    referencePointB: dim.B ?? 0,
    referencePointC: dim.C ?? 0,
    referencePointD: dim.D ?? 0,
    timestamp: v.pos?.at ?? s.at ?? null,
  };
  const loc = v.pos
    ? {
        geometry: { coordinates: [v.pos.lon, v.pos.lat] },
        properties: {
          sog: v.pos.sog,
          cog: v.pos.cog,
          heading: v.pos.heading,
          navStat: v.pos.navStat,
          timestampExternal: v.pos.at,
        },
      }
    : null;
  const item = toItem(register, loc, AISSTREAM_ORIGIN);
  if (item) item.tags = [...item.tags.filter((t) => t !== 'in-range'), 'worldwide'];
  return item;
}

/** Listen to the stream for `ms` and return the per-vessel state. */
export function listen({ apiKey, ms, log, WebSocketImpl = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    const state = new Map();
    let messages = 0;
    let failed = null;
    const ws = new WebSocketImpl(URL_WS);
    ws.binaryType = 'arraybuffer';
    const done = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (failed && !messages) reject(failed);
      else resolve({ state, messages });
    };
    const timer = setTimeout(done, ms);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: [
            [
              [-90, -180],
              [90, 180],
            ],
          ],
          FilterMessageTypes: TYPES,
        }),
      );
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.error) {
        failed = new Error(`aisstream: ${msg.error}`);
        return done();
      }
      messages++;
      absorb(state, msg);
    };
    ws.onerror = (e) => {
      failed = new Error(`aisstream socket error: ${e?.message ?? 'unknown'}`);
    };
    ws.onclose = () => {
      if (messages === 0 && !failed) failed = new Error('aisstream closed before any message');
      done();
      if (log && messages) log(`stream closed after ${messages} messages`);
    };
  });
}

export const aisstream = defineAdapter({
  name: 'aisstream',
  title: 'Ships worldwide (aisstream.io)',
  collection: 'ships',
  description:
    'Ships and boats everywhere a volunteer AIS receiver hears them, from aisstream.io: each run listens to the whole world for six and a half minutes and writes every vessel heard, with name, MMSI, IMO, call sign, type, flag, size, stated destination and last position, speed and navigation status. Needs a free aisstream.io key.',
  docs: 'https://aisstream.io/documentation',
  kinds: ['vessel'],
  cadenceMinutes: 3 * 60,
  budgetMs: 25 * 60_000,
  needsEnv: ['aisstreamApiKey'],
  configFields: [
    { key: 'listenSeconds', label: 'Seconds to listen', type: 'number', help: 'Default 390.' },
  ],
  defaults: { listenSeconds: 390 },
  defaultSources: [{ slug: 'aisstream-worldwide', name: 'Ships worldwide (aisstream.io AIS)' }],

  async *pull({ config, env, log }) {
    if (!env?.aisstreamApiKey) throw new Error('AISSTREAM_API_KEY is not set');
    const ms = Math.min(Math.max(30, Number(config.listenSeconds) || 390), 900) * 1000;
    const { state, messages } = await listen({ apiKey: env.aisstreamApiKey, ms, log });
    let batch = [];
    let wrote = 0;
    let positioned = 0;
    for (const v of state.values()) {
      const item = vesselItem(v);
      if (!item) continue;
      if (item.data.place) positioned++;
      batch.push(item);
      if (batch.length >= 1000) {
        wrote += batch.length;
        yield { items: batch };
        batch = [];
      }
    }
    if (batch.length) {
      wrote += batch.length;
      yield { items: batch };
    }
    log(`${messages} messages, ${wrote} vessels, ${positioned} with a position`);
    return { note: `${wrote} vessels heard in ${ms / 1000}s (${messages} messages)` };
  },
});
