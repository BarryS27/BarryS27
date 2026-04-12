'use client';
import { useCallback } from 'react';
import type { Track } from './useAudio';

interface RawTag {
  title?:   string;
  artist?:  string;
  album?:   string;
  picture?: { data: number[]; format: string };
}

export function useMetadata() {
  const extractMetadata = useCallback(async (file: File): Promise<Partial<Track>> => {
    try {
      const jsmediatags = (await import('jsmediatags')).default;
      const tags = await new Promise<RawTag>(resolve => {
        jsmediatags.read(file, {
          onSuccess: (tag: { tags: RawTag }) => resolve(tag.tags),
          onError:   () => resolve({}),
        });
      });

      let coverArt: string | undefined;
      if (tags.picture?.data) {
        const { data, format } = tags.picture;
        const blob = new Blob([new Uint8Array(data)], { type: format });
        coverArt = await new Promise<string>((res, rej) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === 'string'
              ? res(reader.result)
              : rej(new Error('Unexpected FileReader result type'));
          reader.onerror = () => rej(reader.error ?? new Error('FileReader failed'));
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
  }, []);

  return { extractMetadata };
}

function stripExtension(name: string): string {
  return name.replace(/\.[^/.]+$/, '') || name;
}
