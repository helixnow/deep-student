// Node carrier only. Plugin/application code must not import this module.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadProfile(host, filename) {
  const profile = JSON.parse(await readFile(filename, 'utf8'));
  if (!Array.isArray(profile.plugins) || !profile.plugins.length) throw new Error('Profile must declare plugins');
  const pending = [];
  for (const item of profile.plugins) {
    if (typeof item.entry !== 'string') throw new Error('Plugin entry must be a file path');
    const entry = path.resolve(path.dirname(filename), item.entry);
    const module = await import(pathToFileURL(entry).href);
    const plugin = module.default;
    if (!plugin?.manifest || typeof plugin.activate !== 'function') throw new Error(`Invalid plugin: ${entry}`);
    pending.push(plugin);
  }
  const installed = [];
  try {
    while (pending.length) {
      const index = pending.findIndex((plugin) => plugin.manifest.requires.every((service) => host.has(service)));
      if (index < 0) throw new Error(`Missing or cyclic plugin dependencies: ${pending.map((p) => p.manifest.id).join(', ')}`);
      const [plugin] = pending.splice(index, 1);
      await host.install(plugin);
      installed.push(plugin.manifest.id);
    }
  } catch (error) {
    const failures = [];
    for (const id of installed.reverse()) {
      try { await host.unload(id); } catch (failure) { failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Profile activation and rollback failed');
    throw error;
  }
  return installed;
}
