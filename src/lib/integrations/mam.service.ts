/**
 * Component: MyAnonamouse account service (F7 / L1)
 * Documentation: RMAB2-SPEC.md § F7
 *
 * Read-only view of the MAM account behind the Prowlarr indexer, for the account
 * panel. The session cookie is read from Prowlarr's indexer config over its HTTP
 * API (verified to return `mamId` unredacted) — no second copy of the credential.
 * Mirrors the read-only path of the standalone `mam_monitor.py`.
 *
 * VIP status is NOT exposed by MAM's endpoints (snatch_summary/home/profile carry
 * no vip field; pages are JS shells), but the user CLASS is, and VIP requires Power
 * User — so `vipPossible` (class ≥ Power User) is the reliable gate for [[mam-vip-rule]].
 */

import axios from 'axios';
import { getProwlarrService } from './prowlarr.service';
import { RMABLogger } from '../utils/logger';

const logger = RMABLogger.create('MAM');

const MAM_STATUS_URL = 'https://www.myanonamouse.net/jsonLoad.php?snatch_summary';
// MAM rejects non-browser agents; mirror the read-only monitor's UA.
const MAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const POINT_CAP = 99999;
const POINT_WARN = 90000;
const UNSAT_WARN_FRAC = 0.85;

/**
 * MAM member classes, ascending, per the site FAQ ("What are the different member
 * and staff classes?"): Mouse → User → Power User → VIP → Elite VIP → Elite →
 * Supporter → Mouseketeer → Uploader (staff classes are separate). **VIP is itself
 * a class** — "Can be bought with bonus points or donations. VIP members have their
 * own forum and special VIP freeleech torrents. Note: You must first obtain Power
 * User Status if purchasing with bonus points." An unknown/unmapped class (e.g.
 * staff) returns rank null; VIP detection is by name, not rank.
 */
const CLASS_RANK: Record<string, number> = {
  mouse: 0,
  user: 1,
  'power user': 2,
  vip: 3,
  'elite vip': 4,
  elite: 5,
  supporter: 6,
  mouseketeer: 7,
  uploader: 8,
};
const POWER_USER_RANK = 2;

/**
 * VIP-active = the class name itself says VIP ("VIP", "Elite VIP"). Conservative
 * for every other class (Elite/staff/unknown): keep the exclude rule — a wrongly
 * kept rule only hides auto-candidates (interactive still shows all), while a
 * wrongly dropped rule recreates the original failing-download loop F2 fixed.
 */
function isVipClass(className: string | undefined): boolean {
  return !!className && /\bvip\b/i.test(className);
}

/** Minimal shape of the fields we read from `jsonLoad.php?snatch_summary`. */
interface MamCounter {
  count?: number;
  limit?: number;
}
interface MamSummary {
  classname?: string;
  username?: string;
  seedbonus?: number | string;
  wedges?: number | string;
  ratio?: number | string;
  uploaded_bytes?: number;
  downloaded_bytes?: number;
  sSat?: MamCounter;
  seedHnr?: MamCounter;
  inactHnr?: MamCounter;
  unsat?: MamCounter;
}

export interface MamAccountStatus {
  configured: boolean; // a MAM indexer with a session cookie exists in Prowlarr
  ok: boolean;         // the MAM status fetch succeeded
  error?: string;
  indexerId?: number;  // MAM's Prowlarr indexer id (for scoping the exclude rule)
  username?: string;
  className?: string;
  classRank?: number | null;
  vipActive?: boolean;   // classname is a VIP class ("VIP"/"Elite VIP") → [VIP] releases are freeleech-gettable
  vipPossible?: boolean; // class ≥ Power User — VIP purchasable with bonus points (donations can bypass)
  seedbonus?: number;
  pointCap: number;
  wedges?: number;
  ratio?: number | null;
  uploadedBytes?: number;
  downloadedBytes?: number;
  hnr?: number;
  unsat?: number;
  unsatLimit?: number;
  sat?: number;
  warnings: string[];
}

/** Prowlarr indexer id + MAM session cookie, or null if MAM isn't configured. */
export async function getMamIndexerRef(): Promise<{ id: number; cookie: string } | null> {
  const prowlarr = await getProwlarrService();
  const indexers = await prowlarr.getIndexers();
  for (const ind of indexers) {
    const field = ind.fields?.find((f) => f.name === 'mamId');
    if (field && typeof field.value === 'string' && field.value.trim()) {
      return { id: ind.id, cookie: field.value.trim() };
    }
  }
  return null;
}

function classRankOf(className: string | undefined): number | null {
  if (!className) return null;
  const r = CLASS_RANK[className.trim().toLowerCase()];
  return r === undefined ? null : r;
}

/** Read-only MAM account status for the panel. Never throws — returns ok:false instead. */
export async function getMamAccountStatus(): Promise<MamAccountStatus> {
  let ref: { id: number; cookie: string } | null;
  try {
    ref = await getMamIndexerRef();
  } catch (e) {
    logger.warn('Could not reach Prowlarr to read the MAM session', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { configured: false, ok: false, pointCap: POINT_CAP, warnings: [], error: 'Could not reach Prowlarr to read the MAM session.' };
  }

  if (!ref) {
    return {
      configured: false,
      ok: false,
      pointCap: POINT_CAP,
      warnings: [],
      error: 'No MyAnonamouse indexer with a session cookie is configured in Prowlarr.',
    };
  }

  let d: MamSummary;
  try {
    const resp = await axios.get(MAM_STATUS_URL, {
      headers: { Cookie: `mam_id=${ref.cookie}`, 'User-Agent': MAM_UA },
      timeout: 30000,
    });
    d = (resp.data ?? {}) as MamSummary;
  } catch (e) {
    logger.warn('MAM status fetch failed', { error: e instanceof Error ? e.message : String(e) });
    return {
      configured: true,
      ok: false,
      indexerId: ref.id,
      pointCap: POINT_CAP,
      warnings: [],
      error: 'MAM did not respond — the session cookie may be expired, or MAM is rate-limiting.',
    };
  }

  const counterCount = (c?: MamCounter): number => Number(c?.count ?? 0);
  const className: string | undefined = d.classname ?? undefined;
  const classRank = classRankOf(className);
  const vipActive = isVipClass(className);
  const vipPossible = classRank !== null && classRank >= POWER_USER_RANK;

  const seedbonus = Number(d.seedbonus ?? 0);
  const wedges = Number(d.wedges ?? 0);
  const ratio = d.ratio != null && d.ratio !== '' ? Number(d.ratio) : null;
  const hnr = counterCount(d.seedHnr) + counterCount(d.inactHnr);
  const unsat = counterCount(d.unsat);
  const unsatLimit = Number(d.unsat?.limit ?? 0);
  const sat = counterCount(d.sSat);

  const warnings: string[] = [];
  if (hnr > 0) warnings.push(`Hit-and-run: ${hnr} torrent(s) not seeded long enough — reseed them.`);
  if (seedbonus >= POINT_CAP) warnings.push(`Bonus points at the ${POINT_CAP.toLocaleString()} cap — points earned now are discarded. Spend some.`);
  else if (seedbonus >= POINT_WARN) warnings.push(`Bonus points (${seedbonus.toLocaleString()}) are approaching the ${POINT_CAP.toLocaleString()} cap.`);
  if (unsatLimit > 0 && unsat >= unsatLimit * UNSAT_WARN_FRAC) warnings.push(`Unsatisfied ${unsat}/${unsatLimit} — new grabs may start failing.`);
  if (ratio != null && !Number.isNaN(ratio) && ratio < 1) warnings.push(`Ratio is below 1.0 (${ratio}).`);

  return {
    configured: true,
    ok: true,
    indexerId: ref.id,
    username: d?.username,
    className,
    classRank,
    vipActive,
    vipPossible,
    seedbonus,
    pointCap: POINT_CAP,
    wedges,
    ratio,
    uploadedBytes: Number(d?.uploaded_bytes ?? 0),
    downloadedBytes: Number(d?.downloaded_bytes ?? 0),
    hnr,
    unsat,
    unsatLimit,
    sat,
    warnings,
  };
}
