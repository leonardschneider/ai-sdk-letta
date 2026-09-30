import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentPrimitive, ComposerPrimitive, type Attachment } from '@assistant-ui/react';
import { ImageOff, X } from 'lucide-react';
import { IMAGE_PLACEHOLDER } from './attachments.js';

/**
 * Object URL for a local image, revoked when no longer shown. Data URLs are
 * converted to blobs so the lightbox can open them in a new tab (browsers
 * block top-level navigation to data: URLs).
 */
function useObjectUrl(source: Blob | string | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!source) { setUrl(undefined); return; }
    const blob = typeof source === 'string' ? dataUrlBlob(source) : source;
    if (!blob) { setUrl(undefined); return; }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source]);
  return url;
}

/** Decode a base64 image data URL to a Blob; `undefined` for anything else (never fetches). */
export function dataUrlBlob(url: string): Blob | undefined {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!match) return undefined;
  try {
    const binary = atob(match[2]!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: match[1]!.toLowerCase() });
  } catch { return undefined; }
}

/* ------------------------------------------------------------------ */
/* Lightbox                                                            */
/* ------------------------------------------------------------------ */

type Lightbox = (image: { url: string; name: string }) => void;
const LightboxContext = createContext<Lightbox>(() => {});

/** Click-to-enlarge overlay for local (blob/data) images. Esc or a click outside closes it. */
export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [image, setImage] = useState<{ url: string; name: string }>();
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const open = useCallback<Lightbox>(next => { opener.current = document.activeElement; setImage(next); }, []);
  const dismiss = useCallback(() => { setImage(undefined); (opener.current as HTMLElement | null)?.focus?.({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!image) return;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [image, dismiss]);
  return <LightboxContext.Provider value={open}>
    {children}
    {image && <div className="lightbox" role="dialog" aria-modal="true" aria-label={image.name} onClick={event => { if (!(event.target as Element).closest('.lightbox-bar')) dismiss(); }}>
      <img src={image.url} alt={image.name}/>
      <div className="lightbox-bar">
        <a className="btn small" href={image.url} target="_blank" rel="noopener noreferrer">Open in new tab</a>
        <button ref={close} type="button" className="icon-btn" aria-label="Close image" onClick={dismiss}><X size={18}/></button>
      </div>
    </div>}
  </LightboxContext.Provider>;
}

/* ------------------------------------------------------------------ */
/* Composer: removable thumbnails                                      */
/* ------------------------------------------------------------------ */

function ComposerThumb({ attachment }: { attachment: Attachment }) {
  const url = useObjectUrl(attachment.file ?? attachment.content?.find(p => p.type === 'image')?.image);
  const failed = attachment.status.type === 'incomplete';
  return <AttachmentPrimitive.Root className="thumb" data-failed={failed || undefined} title={attachment.name}>
    {url ? <img src={url} alt={attachment.name}/> : <span className="thumb-fallback"><ImageOff size={16} aria-hidden="true"/></span>}
    <AttachmentPrimitive.Remove className="thumb-remove" aria-label={`Remove ${attachment.name}`} title="Remove"><X size={12} aria-hidden="true"/></AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>;
}

/** Thumbnails of the images in the composer, each with a remove button. */
export function ComposerImages() {
  return <div className="thumbs" aria-label="Attached images">
    <ComposerPrimitive.Attachments>{({ attachment }) => <ComposerThumb attachment={attachment}/>}</ComposerPrimitive.Attachments>
  </div>;
}

/* ------------------------------------------------------------------ */
/* Message bubble images                                               */
/* ------------------------------------------------------------------ */

/** One image in a sent message: live (data URL) or restored from history. Click enlarges it. */
export function MessageImage({ src, name }: { src: string; name?: string }) {
  const blob = useMemo(() => dataUrlBlob(src), [src]);
  const url = useObjectUrl(blob);
  const open = useContext(LightboxContext);
  const label = name || 'Image';
  if (!blob) return <span className="image-placeholder">{IMAGE_PLACEHOLDER}</span>;
  const [loaded, setLoaded] = useState(false);
  // Marking the load changes an attribute, which the thread viewport observes:
  // it keeps following the bottom when an image's height arrives late.
  return <button type="button" className="msg-image" data-loaded={loaded || undefined} aria-label={`Enlarge ${label}`} title="Click to enlarge" disabled={!url} onClick={() => url && open({ url, name: label })}>
    {url && <img src={url} alt={label} onLoad={() => setLoaded(true)}/>}
  </button>;
}
