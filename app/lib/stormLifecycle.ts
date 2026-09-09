import { MIN_STORM_RATE, type StrikePoint } from './stormClusters';
import { buildStormFootprint, footprintContact, type StormFootprintGeometry, type StormFootprintObservation } from './stormFootprint';
import { STORM_OBSERVATION_GAP_MS, STORM_TRANSITION_MS, type StormTransition } from './stormTransition';

const ACTIVE_MS = 5 * 60_000;
const FOOTPRINT_MS = 10 * 60_000;
const MIN_POINTS = MIN_STORM_RATE * 5;

interface Branch { lat: number; lon: number; ids: string[] }
export interface StormLifecycleState {
  observedAt: number;
  /** Exact recent ownership survives changing component order and restarts. */
  members: StrikePoint[];
  supportMembers?: StrikePoint[];
  outline: StormFootprintGeometry | null;
  transitions: StormTransition[];
  splitBranches?: Branch[];
}

export interface LifecycleStorm {
  key: string;
  lat: number;
  lon: number;
  lastSeen: number;
  currentRate: number;
  peakCount: number;
  totalStrikes: number;
  inDb: boolean;
  lastStrikeTime: number;
  lifecycle?: StormLifecycleState;
  replayAnchors?: Array<[number, number, number]>;
}

export function lifecycleStrikeId(p: StrikePoint): string {
  return `${Math.round(p.lat * 1000)},${Math.round(p.lon * 1000)},${p.time}`;
}

function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * 111.32,
    ((a.lon - b.lon + 540) % 360 - 180) * 111.32 * Math.cos((a.lat + b.lat) * Math.PI / 360));
}

function unique(points: StrikePoint[]): StrikePoint[] {
  return [...new Map(points.map(p => [lifecycleStrikeId(p), p])).values()];
}

function centroid(points: StrikePoint[]) {
  const anchor = points[0]?.lon ?? 0;
  const lon = points.reduce((sum, p) => sum + ((p.lon - anchor + 540) % 360 - 180), 0) / points.length + anchor;
  return { lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length, lon: ((lon + 540) % 360) - 180 };
}

function joinedOutline(outlines: Array<StormFootprintGeometry | null>): StormFootprintGeometry | null {
  const present = outlines.filter((outline): outline is StormFootprintGeometry => !!outline);
  return present.length ? { segments: present.flatMap(outline => outline.segments), cores: present.flatMap(outline => outline.cores) } : null;
}

/** Closest spanning links mark real contacts rather than jumping over a third cell. */
function outlineLinks(outlines: Array<StormFootprintGeometry | null>): StormTransition['links'] {
  const edges: Array<{ i: number; j: number; gapKm: number; from: { nx: number; ny: number }; to: { nx: number; ny: number } }> = [];
  for (let i = 0; i < outlines.length; i++) for (let j = i + 1; j < outlines.length; j++) {
    if (!outlines[i] || !outlines[j]) continue;
    const contact = footprintContact(outlines[i]!, outlines[j]!);
    if (contact) edges.push({ i, j, ...contact });
  }
  const roots = outlines.map((_, i) => i);
  const root = (i: number): number => roots[i] === i ? i : (roots[i] = root(roots[i]));
  const links: StormTransition['links'] = [];
  for (const edge of edges.sort((a, b) => a.gapKm - b.gapKm || a.i - b.i || a.j - b.j)) {
    if (root(edge.i) === root(edge.j)) continue;
    roots[root(edge.j)] = root(edge.i);
    links.push({ from: edge.from, to: edge.to });
  }
  return links;
}

function transition(kind: StormTransition['kind'], keys: string[], previous: StormTransition | undefined,
  now: number, links: StormTransition['links']): StormTransition {
  const id = `${kind}:${[...keys].sort().join('|')}`;
  const continuous = previous?.id === id && now >= previous.observedAt && now - previous.observedAt <= STORM_OBSERVATION_GAP_MS;
  const startedAt = continuous ? previous.startedAt : now;
  return { id, kind, stormKeys: [...keys].sort(), startedAt, confirmAt: startedAt + STORM_TRANSITION_MS, observedAt: now, links };
}

/** The same serialization is used on initial SSE connection and every update. */
export function stormLifecycleSummaries<T extends LifecycleStorm>(storms: T[], now: number) {
  const seen = new Set<string>();
  return storms.filter(st => {
    if (seen.has(st.key) || now - st.lastSeen >= ACTIVE_MS || st.currentRate < MIN_STORM_RATE) return false;
    seen.add(st.key);
    return true;
  }).sort((a, b) => b.currentRate - a.currentRate || a.key.localeCompare(b.key)).slice(0, 20).map((st, i) => ({
    key: st.key, lat: st.lat, lon: st.lon, totalStrikes: st.totalStrikes,
    cc: 'cc' in st ? st.cc : null, rate: st.currentRate, rank: i + 1, hasPage: st.inDb,
    outline: st.lifecycle?.outline ?? undefined,
    // New viewers must see the same stale/waiting state as already-open pages.
    // Only reconciliation with fresh evidence cancels or restarts a hold.
    transitions: st.lifecycle?.transitions ?? [],
  }));
}

/**
 * Reconcile physical observations before counts, records or identities change.
 * Each input strike has exactly one current owner. Pending split branches retain
 * their parent; pending merges retain their separate owners until confirmation.
 */
export function reconcileStormLifecycle<T extends LifecycleStorm>(
  storms: T[], observations: StormFootprintObservation[], now: number,
  create: (members: StrikePoint[], parent?: T) => T,
) {
  const assignments = new Map<T, StrikePoint[]>();
  const splits: Array<{ parent: T; child: T; overlap: number }> = [];
  const merges: Array<{ winner: T; losers: T[]; outline: StormFootprintGeometry | null }> = [];
  const previous = new Map(storms.map(st => [st, st.lifecycle]));
  const previousTransitions = new Map<string, StormTransition>();
  const oldOwners = new Map<string, T>();
  const eligible = storms.filter(st => now - st.lastSeen <= 60 * 60_000).sort((a, b) => a.key.localeCompare(b.key));
  const anchors = new Map<T, StrikePoint[]>();
  for (const st of eligible) {
    for (const t of st.lifecycle?.transitions ?? []) previousTransitions.set(t.id, t);
    const owned = st.lifecycle?.members.length ? st.lifecycle.members : st.replayAnchors?.map(([lat, lon, time]) => ({ lat, lon, time })) ?? [];
    const recent = owned.filter(p => p.time > now - FOOTPRINT_MS && p.time <= now);
    anchors.set(st, recent);
    for (const p of recent) if (!oldOwners.has(lifecycleStrikeId(p))) oldOwners.set(lifecycleStrikeId(p), st);
  }
  type Part = { observation: StormFootprintObservation; members: StrikePoint[]; support: StrikePoint[]; active: StrikePoint[]; outline: StormFootprintGeometry | null };
  const parts = new Map<T, Part[]>();
  const touching: T[][] = [];
  // All observations include ten-minute history; only active components may
  // create identities. Quiet components still preserve an existing footprint.
  for (const observation of [...observations].sort((a, b) => a.lat - b.lat || a.lon - b.lon)) {
    const known = new Set<T>();
    for (const p of observation.members) {
      const owner = oldOwners.get(lifecycleStrikeId(p));
      if (owner) known.add(owner);
    }
    if (!known.size) {
      let best: T | undefined;
      let bestKm = Infinity;
      for (const st of eligible) {
        const movementKm = Math.min(60, Math.max(15, (now - st.lastSeen) / 3_600_000 * 120));
        let km = distance(st, observation);
        // Recovery follows the footprint rather than a broad storm's noisy
        // centroid. Its bound never joins an unrelated distant observation.
        for (const p of anchors.get(st) ?? []) km = Math.min(km, distance(p, observation));
        if (km <= movementKm && km < bestKm) { bestKm = km; best = st; }
      }
      if (best) known.add(best);
      else if (observation.activeMembers.length >= MIN_POINTS) {
        const fresh = create(observation.activeMembers);
        storms.push(fresh);
        known.add(fresh);
      }
    }
    if (!known.size) continue;
    const owners = [...known].sort((a, b) => a.key.localeCompare(b.key));
    const allocations = new Map(owners.map(st => [st, [] as StrikePoint[]]));
    const supportIds = new Set((observation.supportMembers ?? observation.members).map(lifecycleStrikeId));
    for (const p of observation.members) {
      let owner = oldOwners.get(lifecycleStrikeId(p));
      if (!owner || !known.has(owner)) owner = owners.reduce((best, st) => distance(p, st) < distance(p, best) ? st : best);
      allocations.get(owner)!.push(p);
    }
    const contactOwners: T[] = [];
    for (const [owner, members] of allocations) {
      const active = members.filter(p => p.time > now - ACTIVE_MS && p.time <= now);
      const list = parts.get(owner) ?? [];
      const support = members.filter(p => supportIds.has(lifecycleStrikeId(p)));
      // Preserve observed boundaries exactly for whole components. Partitioned
      // owners use one common reference so raster phase cannot invent a gap.
      const outline = owners.length === 1 ? observation.outline : buildStormFootprint(support, observation);
      list.push({ observation, members, active, support, outline });
      parts.set(owner, list);
      // Contact can occur on a weaker branch of an otherwise qualified storm.
      // Qualification belongs to the whole identity, after all parts are owned.
      if (support.length) contactOwners.push(owner);
    }
    if (contactOwners.length > 1) touching.push(contactOwners);
  }

  for (const st of storms) {
    const own = parts.get(st) ?? [];
    const members = unique(own.flatMap(p => p.members));
    const active = unique(own.flatMap(p => p.active));
    const support = unique(own.flatMap(p => p.support));
    st.lifecycle = { observedAt: now, members, supportMembers: support, outline: joinedOutline(own.map(p => p.outline)), transitions: [] };
    if (active.length >= MIN_POINTS) assignments.set(st, active);
  }

  // Connected sets support three-way contact without confirming an A+B subset
  // early when C joins. A changed participant set starts a new full hold.
  const mergeGroups: Set<T>[] = [];
  const contacts: T[][] = [];
  for (const group of touching) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    if (!assignments.has(group[i]) || !assignments.has(group[j])) continue;
    const a = group[i].lifecycle!.outline, b = group[j].lifecycle!.outline;
    if (a && b && footprintContact(a, b)?.gapKm === 0) contacts.push([group[i], group[j]]);
  }
  for (const group of contacts) {
    const connected = mergeGroups.filter(g => group.some(st => g.has(st)));
    const union = new Set([...group, ...connected.flatMap(g => [...g])]);
    for (const g of connected) mergeGroups.splice(mergeGroups.indexOf(g), 1);
    mergeGroups.push(union);
  }
  const mergingOwners = new Set(mergeGroups.flatMap(g => [...g]));
  for (const group of mergeGroups) {
    const owners = [...group].sort((a, b) => b.peakCount - a.peakCount || a.key.localeCompare(b.key));
    const keys = owners.map(st => st.key).sort();
    const links = outlineLinks(owners.map(st => st.lifecycle!.outline));
    const t = transition('merge', keys, previousTransitions.get(`merge:${keys.join('|')}`), now, links);
    if (now >= t.confirmAt) {
      const wholeObservations = new Set(owners.flatMap(st => (parts.get(st) ?? []).map(p => p.observation)));
      merges.push({ winner: owners[0], losers: owners.slice(1), outline: joinedOutline([...wholeObservations].map(p => p.outline)) });
    }
    else for (const st of owners) st.lifecycle!.transitions.push(t);
  }

  for (const [st, own] of parts) {
    if (mergingOwners.has(st)) continue;
    const branches = own.filter(p => p.active.length >= MIN_POINTS);
    if (branches.length < 2) continue;
    const before = previous.get(st);
    const unmatched = new Set(before?.splitBranches ?? []);
    let sameBranches = unmatched.size === branches.length;
    for (const branch of branches) {
      const ids = new Set(branch.members.map(lifecycleStrikeId));
      const match = [...unmatched].find(b => b.ids.some(id => ids.has(id)));
      if (match) unmatched.delete(match);
      else sameBranches = false;
    }
    const links = outlineLinks(branches.map(p => p.outline));
    const prior = sameBranches ? before?.transitions.find(t => t.kind === 'split') : undefined;
    const t = transition('split', [st.key], prior, now, links);
    if (now < t.confirmAt) {
      st.lifecycle!.transitions.push(t);
      st.lifecycle!.splitBranches = branches.map(b => ({ ...centroid(b.members), ids: b.members.map(lifecycleStrikeId) }));
      continue;
    }
    // Retain the established identity on the strongest branch. Seed new child
    // context only now; historical points already counted by the parent get an
    // explicit overlap so a later re-merge cannot count them twice.
    branches.sort((a, b) => b.active.length - a.active.length || a.observation.lat - b.observation.lat || a.observation.lon - b.observation.lon);
    const detached = new Set(branches.slice(1));
    const remaining = own.filter(p => !detached.has(p));
    assignments.set(st, unique(remaining.flatMap(p => p.active)));
    const retainedSupport = unique(remaining.flatMap(p => p.support));
    st.lifecycle = { observedAt: now, members: unique(remaining.flatMap(p => p.members)), supportMembers: retainedSupport,
      outline: joinedOutline(remaining.map(p => p.outline)), transitions: [] };
    for (const branch of branches.slice(1)) {
      const child = create(branch.active, st);
      child.lifecycle = { observedAt: now, members: branch.members, supportMembers: branch.support, outline: branch.outline, transitions: [] };
      storms.push(child);
      assignments.set(child, branch.active);
      splits.push({ parent: st, child, overlap: branch.active.filter(p => p.time <= st.lastStrikeTime).length });
    }
  }
  return { assignments, splits, merges };
}

/** Merge the persisted ownership as well as the replay/count state. */
export function combineStormLifecycle(winner: LifecycleStorm, losers: LifecycleStorm[], now: number, outline?: StormFootprintGeometry | null): void {
  const states = [winner, ...losers].map(st => st.lifecycle).filter((s): s is StormLifecycleState => !!s);
  const members = unique(states.flatMap(s => s.members));
  const supportMembers = unique(states.flatMap(s => s.supportMembers ?? []));
  winner.lifecycle = { observedAt: now, members, supportMembers,
    outline: outline ?? (supportMembers.length ? buildStormFootprint(supportMembers, winner) : null), transitions: [] };
  winner.lastStrikeTime = Math.max(winner.lastStrikeTime, ...losers.map(st => st.lastStrikeTime));
}
