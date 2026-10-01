import React, { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { versionLine, versionParts, type Versions } from './versions.js';

/** The server's installed versions (About section): selectable, with a copy button for bug reports. */
export function VersionInfo({ versions }: { versions: Versions | undefined }) {
  const line = versionLine(versions);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(t); }, [copied]);
  if (!line) return null;
  return <p className="versions">
    {/* Wraps only between packages; selecting or copying gives the one-line form. */}
    <span className="mono versions-text">{versionParts(versions).map((part, i) => <React.Fragment key={part}>{i > 0 && ' · '}<span className="versions-part">{part}</span></React.Fragment>)}</span>
    <button type="button" className="icon-btn small versions-copy" aria-label="Copy versions" title={copied ? 'Copied' : 'Copy versions'}
      onClick={() => void navigator.clipboard?.writeText(line).then(() => setCopied(true), () => {})}>
      {copied ? <Check size={13} aria-hidden="true"/> : <Copy size={13} aria-hidden="true"/>}
    </button>
    <span className="sr-only" role="status">{copied ? 'Versions copied' : ''}</span>
  </p>;
}
