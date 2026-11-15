/** A change in login identity invalidates in-flight lookups on both hosts. */
let authEpoch = 1;
export function invalidateAuth(): void { authEpoch += 1; }
export function currentAuthEpoch(): number { return authEpoch; }
