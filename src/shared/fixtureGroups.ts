import { FixtureType, Universe } from './dmxFixtures'

/** Normalize a user-entered fixture group name; returns null if empty after trim. */
export function normalizeFixtureGroupName(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  return trimmed
}

/** Unique, non-empty group names in stable order (first occurrence wins). */
export function normalizeFixtureGroupList(groups: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of groups) {
    const name = normalizeFixtureGroupName(raw)
    if (name === null) {
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(name)
  }
  return out
}

function compareFixtureGroupNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

/** Default scene/split group names — one per fixture type currently on the universe. */
export function fixtureTypeDefaultGroupNames(
  universe: Universe,
  fixtureTypesById: { [id: string]: FixtureType }
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const fixture of universe) {
    const fixtureType = fixtureTypesById[fixture.type]
    if (fixtureType === undefined) {
      continue
    }
    const name = normalizeFixtureGroupName(fixtureType.name)
    if (name === null) {
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    names.push(name)
  }
  return names.sort(compareFixtureGroupNames)
}

function countAssignedFixtureGroups(universe: Universe) {
  const counts = new Map<string, { name: string; count: number }>()
  for (const fixture of universe) {
    for (const raw of fixture.groups) {
      const name = normalizeFixtureGroupName(raw)
      if (name === null) {
        continue
      }
      const key = name.toLowerCase()
      const existing = counts.get(key)
      if (existing !== undefined) {
        existing.count += 1
      } else {
        counts.set(key, { name, count: 1 })
      }
    }
  }
  return counts
}

/**
 * Groups offered in pickers: fixture-type defaults for the current rig, plus custom
 * group names that are assigned to at least one patched fixture.
 */
export function getFixtureGroupPickerOptions(
  universe: Universe,
  fixtureTypesById: { [id: string]: FixtureType }
): string[] {
  const defaults = fixtureTypeDefaultGroupNames(universe, fixtureTypesById)
  const defaultKeys = new Set(defaults.map((name) => name.toLowerCase()))
  const assigned = countAssignedFixtureGroups(universe)
  const options = [...defaults]

  for (const { name, count } of assigned.values()) {
    if (count <= 0) {
      continue
    }
    const key = name.toLowerCase()
    if (defaultKeys.has(key)) {
      continue
    }
    defaultKeys.add(key)
    options.push(name)
  }

  return options.sort(compareFixtureGroupNames)
}

/** Remove group names from patched fixtures when they are no longer valid. */
export function pruneFixtureGroupsInUniverse(
  universe: Universe,
  fixtureTypesById: { [id: string]: FixtureType }
): void {
  const validKeys = new Set(
    getFixtureGroupPickerOptions(universe, fixtureTypesById).map((name) =>
      name.toLowerCase()
    )
  )

  for (const fixture of universe) {
    fixture.groups = normalizeFixtureGroupList(
      fixture.groups.filter((group) => validKeys.has(group.toLowerCase()))
    )
  }
}

/** Keep patched fixture `groups` aligned with the current rig (call after add/remove). */
export function syncFixtureGroupCatalog(
  universe: Universe,
  fixtureTypesById: { [id: string]: FixtureType }
): void {
  pruneFixtureGroupsInUniverse(universe, fixtureTypesById)
}

/**
 * Group names assigned to subfixtures of fixture types patched on the universe.
 * Subfixture groups live on the fixture *type*, so they are invisible to the
 * universe-level scan in {@link countAssignedFixtureGroups}.
 */
export function subFixtureGroupNamesOnUniverse(
  universe: Universe,
  fixtureTypesById: { [id: string]: FixtureType }
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const fixture of universe) {
    const fixtureType = fixtureTypesById[fixture.type]
    if (fixtureType === undefined) {
      continue
    }
    for (const sub of fixtureType.subFixtures) {
      for (const raw of sub.groups) {
        const name = normalizeFixtureGroupName(raw)
        if (name === null) {
          continue
        }
        const key = name.toLowerCase()
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        names.push(name)
      }
    }
  }
  return names.sort(compareFixtureGroupNames)
}

/**
 * Groups a split (or the group control page) can target: everything the fixture picker
 * offers, plus subfixture groups from patched fixture types. `flatten_fixture` merges
 * each subfixture's groups into its partition, so those names already match at output
 * time — they just were not offered anywhere to select.
 */
export function getTargetableGroupOptions(
  universe: Universe,
  fixtureTypesById: { [id: string]: FixtureType }
): string[] {
  const options = getFixtureGroupPickerOptions(universe, fixtureTypesById)
  const seen = new Set(options.map((name) => name.toLowerCase()))

  for (const name of subFixtureGroupNamesOnUniverse(universe, fixtureTypesById)) {
    const key = name.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    options.push(name)
  }

  return options.sort(compareFixtureGroupNames)
}

/**
 * Every group name a fixture takes part in: its own groups plus the groups assigned to any
 * of its subfixtures. Group matching at output time is per-partition — `flatten_fixture`
 * merges each subfixture's groups into its partition — so UI scans asking "is this fixture
 * in the split?" must consider subfixture groups too, or a split targeting only a
 * subfixture group looks empty and offers no controls.
 *
 * Names are trimmed but keep their case: callers compare them against split group keys,
 * which are matched exactly.
 */
export function fixtureGroupNamesWithSubFixtures(
  fixtureGroups: string[],
  fixtureType: Pick<FixtureType, 'subFixtures'> | undefined
): Set<string> {
  const names = new Set<string>()
  for (const raw of fixtureGroups) {
    const name = raw.trim()
    if (name.length > 0) {
      names.add(name)
    }
  }
  for (const sub of fixtureType?.subFixtures ?? []) {
    for (const raw of sub.groups) {
      const name = raw.trim()
      if (name.length > 0) {
        names.add(name)
      }
    }
  }
  return names
}
