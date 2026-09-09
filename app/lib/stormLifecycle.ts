import { MIN_STORM_RATE, type StrikePoint } from './stormClusters';
import { buildStormFootprint, footprintContact, type StormFootprintGeometry, type StormFootprintObservation } from './stormFootprint';
import { STORM_DISTANT_SPLIT_KM, STORM_DISTANT_SPLIT_MS, STORM_OBSERVATION_GAP_MS, STORM_TRANSITION_MS, type StormTransition } from './stormTransition';

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
  /** Ordinary separation keeps its own hold while a distant gap comes and goes. */
  splitTransition?: StormTransition;
  distantSplit?: { branches: Branch[]; transition: StormTransition };
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
  splitNotBefore?: number;
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
  now: number, links: StormTransition['links'], duration = STORM_TRANSITION_MS): StormTransition {
  const id = `${kind}:${[...keys].sort().join('|')}`;
  const continuous = previous?.id === id && now >= previous.observedAt && now - previous.observedAt <= STORM_OBSERVATION_GAP_MS;
  const startedAt = continuous ? previous.startedAt : now;
  return { id, kind, stormKeys: [...keys].sort(), startedAt, confirmAt: startedAt + duration, observedAt: now, links };
}

function describeBranches(branches: StrikePoint[][]): Branch[] {
  return branches.map(members => ({ ...centroid(members), ids: members.map(lifecycleStrikeId) }));
}

/** Require the same partition, including when one old group touches two new groups. */
function sameBranches(before: Branch[] | undefined, branches: StrikePoint[][]): boolean {
  if (!before || before.length !== branches.length) return false;
  const matched = new Set<Branch>();
  for (const members of branches) {
    const ids = new Set(members.map(lifecycleStrikeId));
    const matches = before.filter(branch => branch.ids.some(id => ids.has(id)));
    if (matches.length !== 1 || matched.has(matches[0])) return false;
    matched.add(matches[0]);
  }
  return true;
}

/** Nearby branches stay together when confirming only clearly distant groups. */
function distantGroups<T extends { outline: StormFootprintGeometry | null }>(branches: T[]): T[][] {
  const roots = branches.map((_, i) => i);
  const root = (i: number): number => roots[i] === i ? i : (roots[i] = root(roots[i]));
  for (let i = 0; i < branches.length; i++) for (let j = i + 1; j < branches.length; j++) {
    const a = branches[i].outline, b = branches[j].outline;
    const contact = a && b ? footprintContact(a, b) : null;
    // Missing boundary evidence cannot establish a fifty-kilometre gap.
    if (!contact || contact.gapKm < STORM_DISTANT_SPLIT_KM) roots[root(j)] = root(i);
  }
  const groups = new Map<number, T[]>();
  for (let i = 0; i < branches.length; i++) {
    const key = root(i), group = groups.get(key) ?? [];
    group.push(branches[i]);
    groups.set(key, group);
  }
  return [...groups.values()];
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
    const branchMembers = branches.map(branch => branch.members);
    const prior = sameBranches(before?.splitBranches, branchMembers)
      ? before?.splitTransition ?? before?.transitions.find(t => t.kind === 'split') : undefined;
    const normal = transition('split', [st.key], prior, now, outlineLinks(branches.map(p => p.outline)));
    normal.confirmAt = Math.max(normal.confirmAt, st.splitNotBefore ?? 0);
    st.lifecycle!.splitTransition = normal;
    st.lifecycle!.splitBranches = describeBranches(branchMembers);

    const farGroups = distantGroups(branches);
    let distant: StormTransition | undefined;
    if (farGroups.length > 1) {
      const groupMembers = farGroups.map(group => unique(group.flatMap(p => p.members)));
      const previousDistant = sameBranches(before?.distantSplit?.branches, groupMembers) ? before?.distantSplit?.transition : undefined;
      distant = transition('split', [st.key], previousDistant, now,
        outlineLinks(farGroups.map(group => joinedOutline(group.map(p => p.outline)))), STORM_DISTANT_SPLIT_MS);
      distant.confirmAt = Math.max(distant.confirmAt, st.splitNotBefore ?? 0);
      st.lifecycle!.distantSplit = { branches: describeBranches(groupMembers), transition: distant };
    }
    const fast = distant !== undefined && distant.confirmAt < normal.confirmAt;
    const displayed = fast ? distant! : normal;
    if (now < displayed.confirmAt) {
      st.lifecycle!.transitions.push(displayed);
      continue;
    }

    // A short hold separates distant groups as units. Nearby branches still
    // need the ordinary five minutes, even if another group is far away.
    const groups = (fast ? farGroups : branches.map(branch => [branch])).map(group => ({
      parts: group, members: unique(group.flatMap(p => p.members)), active: unique(group.flatMap(p => p.active)),
      support: unique(group.flatMap(p => p.support)), outline: joinedOutline(group.map(p => p.outline)),
    }));
    groups.sort((a, b) => b.active.length - a.active.length || a.parts[0].observation.lat - b.parts[0].observation.lat || a.parts[0].observation.lon - b.parts[0].observation.lon);
    const detached = new Set(groups.slice(1).flatMap(group => group.parts));
    const remaining = own.filter(p => !detached.has(p));
    assignments.set(st, unique(remaining.flatMap(p => p.active)));
    const retainedSupport = unique(remaining.flatMap(p => p.support));
    st.lifecycle = { observedAt: now, members: unique(remaining.flatMap(p => p.members)), supportMembers: retainedSupport,
      outline: joinedOutline(remaining.map(p => p.outline)), transitions: [] };

    function preserveNearbyHold(owner: T, group: Part[]) {
      if (!fast || group.length < 2) return;
      const pending: StormTransition = { ...normal, id: `split:${owner.key}`, stormKeys: [owner.key], links: outlineLinks(group.map(p => p.outline)) };
      owner.lifecycle!.splitTransition = pending;
      owner.lifecycle!.splitBranches = describeBranches(group.map(p => p.members));
      owner.lifecycle!.transitions.push(pending);
    }
    preserveNearbyHold(st, groups[0].parts);
    for (const group of groups.slice(1)) {
      const child = create(group.active, st);
      child.lifecycle = { observedAt: now, members: group.members, supportMembers: group.support, outline: group.outline, transitions: [] };
      preserveNearbyHold(child, group.parts);
      storms.push(child);
      assignments.set(child, group.active);
      splits.push({ parent: st, child, overlap: group.active.filter(p => p.time <= st.lastStrikeTime).length });
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
  const splitNotBefore = Math.max(winner.splitNotBefore ?? 0, ...losers.map(st => st.splitNotBefore ?? 0));
  if (splitNotBefore > 0) winner.splitNotBefore = splitNotBefore;
}
