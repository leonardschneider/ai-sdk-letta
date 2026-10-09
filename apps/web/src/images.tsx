import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentPrimitive, ComposerPrimitive, type Attachment } from '@assistant-ui/react';
import { Download, FileCode2, FileSpreadsheet, FileText, ImageOff, X } from 'lucide-react';
import { IMAGE_PLACEHOLDER, fileDetail, type FileInfo } from './attachments.js';

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

/** Icon for a file chip, by kind and name. */
export function FileIcon({ name, kind, size = 18 }: { name: string; kind?: string; size?: number }) {
  const Icon = kind === 'pdf' ? FileText : /\.(csv|tsv)$/i.test(name) ? FileSpreadsheet : /\.(md|markdown|txt|text|log)$/i.test(name) || kind === 'pdf' ? FileText : FileCode2;
  return <span className="file-icon" data-kind={kind ?? 'text'} aria-hidden="true"><Icon size={size}/></span>;
}

/** A file in the composer: icon, name, type and size, with a remove button. */
function ComposerFile({ attachment, info }: { attachment: Attachment; info?: FileInfo }) {
  const detail = info ? fileDetail(info) : '';
  return <AttachmentPrimitive.Root className="file-chip composer-file" title={detail ? `${attachment.name} · ${detail}` : attachment.name}>
    <FileIcon name={attachment.name} kind={info?.kind}/>
    <span className="file-text"><span className="file-name">{attachment.name}</span>{detail && <span className="file-detail">{detail}</span>}</span>
    <AttachmentPrimitive.Remove className="thumb-remove" aria-label={`Remove ${attachment.name}`} title="Remove"><X size={12} aria-hidden="true"/></AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>;
}

/** Thumbnails of the images and chips of the files in the composer, each with a remove button. */
export function ComposerImages({ fileInfo }: { fileInfo?: (id: string) => FileInfo | undefined }) {
  return <div className="thumbs" aria-label="Attachments">
    <ComposerPrimitive.Attachments>{({ attachment }) => attachment.type === 'image' ? <ComposerThumb attachment={attachment}/> : <ComposerFile attachment={attachment} info={fileInfo?.(attachment.id)}/>}</ComposerPrimitive.Attachments>
  </div>;
}

/* ------------------------------------------------------------------ */
/* Message bubble files                                                */
/* ------------------------------------------------------------------ */

/** Opens or downloads a sent file. `href` is set once the file is stored in the conversation. */
export type FileLink = (name: string) => string | undefined;
export const FileLinkContext = createContext<FileLink>(() => undefined);

/** A file in a sent message. Click downloads it (PDFs open in a new tab, rendered by the browser's viewer). */
export function MessageFile({ name, detail, kind }: { name: string; detail: string; kind?: string }) {
  const href = useContext(FileLinkContext)(name);
  const body = <><FileIcon name={name} kind={kind}/><span className="file-text"><span className="file-name">{name}</span><span className="file-detail">{detail}</span></span>{href && <Download size={14} className="file-action" aria-hidden="true"/>}</>;
  return href
    ? <a className="file-chip msg-file" href={href} download={name} title={`Download ${name}`} aria-label={`Download ${name}, ${detail}`}>{body}</a>
    : <span className="file-chip msg-file" title={name} aria-label={`${name}, ${detail}`}>{body}</span>;
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
  // Before any early return: hooks run in the same order whatever the image (a placeholder can become an image).
  const [loaded, setLoaded] = useState(false);
  if (!blob) return <span className="image-placeholder">{IMAGE_PLACEHOLDER}</span>;
  // Marking the load changes an attribute, which the thread viewport observes:
  // it keeps following the bottom when an image's height arrives late.
  return <button type="button" className="msg-image" data-loaded={loaded || undefined} aria-label={`Enlarge ${label}`} title="Click to enlarge" disabled={!url} onClick={() => url && open({ url, name: label })}>
    {url && <img src={url} alt={label} onLoad={() => setLoaded(true)}/>}
  </button>;
}
