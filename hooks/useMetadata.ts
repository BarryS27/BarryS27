'use client';
import { useCallback } from 'react';
import type { Track } from './useAudio';

interface RawTag {
  title?: string;
  artist?: string;
  album?: string;
  picture?: {
    data: number[];
    format: string;
  };
}

/**
 * Extracts ID3 metadata + cover art from a local File using jsmediatags.
 * Falls back gracefully — always resolves, never rejects.
 */
export function useMetadata() {
  const extractMetadata = useCallback(
    async (file: File): Promise<Partial<Track>> => {
      try {
        const jsmediatags = (await import('jsmediatags')).default;

        // jsmediatags reads directly from the File object — no Object URL needed
        const tags = await new Promise<RawTag>((resolve) => {
          jsmediatags.read(file, {
            onSuccess: (tag: { tags: RawTag }) => resolve(tag.tags),
            onError: () => resolve({}),
          });
        });

        let coverArt: string | undefined;
        if (tags.picture?.data) {
          const { data, format } = tags.picture;
          const bytes = new Uint8Array(data);
          const blob = new Blob([bytes], { type: format });
          coverArt = await new Promise<string>((res, rej) => {
            const reader = new FileReader();
            // FIX: reader.result can be string | ArrayBuffer | null depending on
            // which readAs* method was called. readAsDataURL always yields a string,
            // but the cast `reader.result as string` silently produces a wrong value
            // if the runtime hands back an ArrayBuffer. Guard with typeof.
            reader.onload = () => {
              if (typeof reader.result === 'string') {
                res(reader.result);
              } else {
                rej(new Error('Unexpected FileReader result type'));
              }
            };
            reader.onerror = () => rej(reader.error);
            reader.readAsDataURL(blob);
          });
        }

        return {
          title:    tags.title  || stripExtension(file.name),
          artist:   tags.artist,
          album:    tags.album,
          coverArt,
        };
      } catch {
        return { title: stripExtension(file.name) };
      }
    },
    []
  );

  return { extractMetadata };
}

function stripExtension(name: string): string {
  // FIX: /\.[^/.]+$/ matches the entire name for dotfiles like '.bashrc',
  // producing an empty string.  Fall back to the original name in that case.
  return name.replace(/\.[^/.]+$/, '') || name;
}
