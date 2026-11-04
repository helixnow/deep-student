import { useCallback, useEffect, useRef, useState } from 'react';
import { loadInkBackground, type InkBackgroundLease } from './background';
import { getFrozenInkRenderInputs } from './renderBridge';
import { composeSourceHighlights } from './sourceHighlights';
import type { InkManifest, InkPageRef } from './types';

export interface InkBackgroundInput {
  documentId: string;
  status: 'loading' | 'ready' | 'error';
  manifest?: InkManifest;
  pageRef?: InkPageRef;
}

export interface InkBackgroundView {
  background?: CanvasImageSource;
  error: boolean;
}

interface BaseEntry {
  key: string;
  lease: InkBackgroundLease;
  refs: number;
}

interface PublishedBackground {
  key: string;
  /** documentId + page_id this bitmap belongs to; never let it bleed into another page. */
  identity: string;
  background?: CanvasImageSource;
  dispose(): void;
}

/** Reuses the decoded raster while a save/rename only advances the manifest revision. */
export function inkBackgroundBaseKey(documentId: string, pageRef: InkPageRef): string {
  const { background } = pageRef;
  const source = background.kind === 'blank'
    ? 'blank'
    : background.kind === 'image'
      ? `image:${background.blob_hash}`
      : `pdf_page:${background.blob_hash}:${background.source_page_index}`;
  return JSON.stringify([documentId, pageRef.page_id, pageRef.width, pageRef.height, source]);
}

/** Order-independent signature so unchanged refetched highlights are a no-op. */
export function inkHighlightSignature(highlights: Array<Record<string, unknown>>): string {
  return highlights.length ? stableStringify(highlights) : '';
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function retain(entry: BaseEntry): void {
  entry.refs += 1;
}

/** Only the last owner closes the bitmap; a published lease may outlive the cache entry. */
function release(entry: BaseEntry): void {
  entry.refs -= 1;
  if (entry.refs <= 0) entry.lease.dispose();
}

function pageIdentity(documentId: string, pageRef: InkPageRef): string {
  return `${documentId}\u0000${pageRef.page_id}`;
}

/**
 * Publishes a background keyed by blob + highlight signature, not by the
 * manifest/page objects a save or rename replaces. Revisions still refetch
 * highlights; only an unchanged raster is reused. Base bitmaps are reference
 * counted and never closed before React commits their replacement.
 */
export function useInkBackground({ documentId, status, manifest, pageRef }: InkBackgroundInput): InkBackgroundView {
  const [published, setPublished] = useState<PublishedBackground>();
  const [error, setError] = useState(false);
  const publishedRef = useRef<PublishedBackground>();
  const retiredRef = useRef<PublishedBackground[]>([]);
  const baseRef = useRef<BaseEntry | null>(null);
  const desiredBaseKeyRef = useRef<string | null>(null);
  const pageIdentityRef = useRef<string | undefined>(undefined);

  const publish = useCallback((next?: PublishedBackground) => {
    const previous = publishedRef.current;
    if (previous && previous !== next) retiredRef.current.push(previous);
    publishedRef.current = next;
    setPublished(next);
  }, []);

  const releaseCachedBase = useCallback(() => {
    const cached = baseRef.current;
    baseRef.current = null;
    if (cached) release(cached);
  }, []);

  // Retired values are closed in a passive effect after the replacement
  // committed; the list also covers publishes coalesced into one commit.
  useEffect(() => {
    if (!retiredRef.current.length) return;
    const committed = published;
    retiredRef.current = retiredRef.current.filter((candidate) => {
      if (candidate === committed) return true;
      candidate.dispose();
      return false;
    });
  }, [published]);

  useEffect(() => () => {
    const current = publishedRef.current;
    publishedRef.current = undefined;
    current?.dispose();
    for (const retired of retiredRef.current) retired.dispose();
    retiredRef.current = [];
  }, []);

  useEffect(() => () => {
    const cached = baseRef.current;
    baseRef.current = null;
    if (cached) release(cached);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let runBase: BaseEntry | undefined;
    const releaseRunBase = () => {
      if (!runBase) return;
      const entry = runBase;
      runBase = undefined;
      release(entry);
    };
    const fail = () => {
      if (!cancelled) setError(true);
    };

    setError(false);

    if (status !== 'ready' || !manifest || !pageRef) {
      desiredBaseKeyRef.current = null;
      releaseCachedBase();
      if (publishedRef.current) publish(undefined);
      return () => { cancelled = true; };
    }

    const identity = pageIdentity(documentId, pageRef);
    if (pageIdentityRef.current !== identity) {
      pageIdentityRef.current = identity;
      if (publishedRef.current) publish(undefined);
    }

    const baseKey = inkBackgroundBaseKey(documentId, pageRef);
    desiredBaseKeyRef.current = baseKey;

    if (pageRef.background.kind === 'blank') {
      releaseCachedBase();
      if (publishedRef.current?.key !== baseKey) {
        publish({ identity, key: baseKey, background: undefined, dispose() {} });
      }
      return () => { cancelled = true; };
    }

    if (baseRef.current?.key !== baseKey) releaseCachedBase();
    const cachedBase = baseRef.current;

    void (async () => {
      let entry: BaseEntry;
      if (cachedBase?.key === baseKey) {
        retain(cachedBase);
        entry = cachedBase;
      } else {
        let lease: InkBackgroundLease;
        try {
          lease = await loadInkBackground(pageRef);
        } catch {
          fail();
          return;
        }
        if (cancelled || desiredBaseKeyRef.current !== baseKey) {
          lease.dispose();
          return;
        }
        entry = { key: baseKey, lease, refs: 0 };
        retain(entry); // cache owner
        baseRef.current = entry;
        retain(entry); // this run
      }
      runBase = entry;
      if (cancelled) {
        releaseRunBase();
        return;
      }

      let highlights: Array<Record<string, unknown>> = [];
      if (manifest.source.kind === 'resource') {
        let inputs: Awaited<ReturnType<typeof getFrozenInkRenderInputs>>;
        try {
          inputs = await getFrozenInkRenderInputs(documentId, manifest.revision, pageRef.page_id);
        } catch {
          releaseRunBase();
          fail();
          return;
        }
        if (cancelled) {
          releaseRunBase();
          return;
        }
        if (inputs.revision !== manifest.revision || inputs.page_ref.page_id !== pageRef.page_id
          || inputs.page.page_id !== pageRef.page_id) {
          releaseRunBase();
          fail();
          return;
        }
        highlights = inputs.highlights;
      }

      const signature = inkHighlightSignature(highlights);
      const displayKey = signature ? `${baseKey}\u0000${signature}` : baseKey;
      if (publishedRef.current?.key === displayKey) {
        releaseRunBase();
        return;
      }

      let composed: HTMLCanvasElement | undefined;
      try {
        composed = composeSourceHighlights(entry.lease.background, pageRef, highlights);
      } catch {
        releaseRunBase();
        fail();
        return;
      }
      if (cancelled) {
        if (composed) {
          composed.width = 0;
          composed.height = 0;
        }
        releaseRunBase();
        return;
      }

      if (composed) {
        const canvas = composed;
        let disposed = false;
        // The composed canvas owns its pixels; the cached base stays reusable
        // for the next highlight revision.
        publish({
          identity,
          key: displayKey,
          background: canvas,
          dispose() {
            if (disposed) return;
            disposed = true;
            canvas.width = 0;
            canvas.height = 0;
          },
        });
        releaseRunBase();
        return;
      }

      retain(entry);
      let released = false;
      publish({
        identity,
        key: displayKey,
        background: entry.lease.background,
        dispose() {
          if (released) return;
          released = true;
          release(entry);
        },
      });
      releaseRunBase();
    })();

    return () => {
      cancelled = true;
      if (desiredBaseKeyRef.current === baseKey) desiredBaseKeyRef.current = null;
      releaseRunBase();
    };
  }, [documentId, status, manifest, pageRef, publish, releaseCachedBase]);

  // A page switch renders before this hook's passive effect clears `published`;
  // gate the child-visible value by identity so it never paints across pages.
  const targetIdentity = pageRef ? pageIdentity(documentId, pageRef) : undefined;
  const visible = published && published.identity === targetIdentity ? published : undefined;
  return { background: visible?.background, error };
}
