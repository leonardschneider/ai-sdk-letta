/**
 * The Atlassian document renderer (`@atlaskit/renderer`), loaded only when a
 * `.adf.json` preview opens (a separate chunk of about 1 MB gzipped).
 *
 * Offline by construction: smart links resolve locally (never through
 * Atlassian's link service), media are drawn from this app's own proxy
 * (`/v1/resources/atlassian-media`, which fetches them with your account) or
 * as a placeholder, Atlaskit's error reporting is stubbed out at build time
 * (see vite.config.ts), and the theme follows the app's light or dark mode.
 */
import React, { useEffect, useState } from 'react';
import { IntlProvider } from 'react-intl';
import { ReactRenderer } from '@atlaskit/renderer';
import { SmartCardProvider } from '@atlaskit/link-provider';
import { setGlobalTheme } from '@atlaskit/tokens/set-global-theme';
import type { DocNode } from '@atlaskit/adf-schema';

type Media = Record<string, { name: string; mediaType?: string; download?: string }>;
type MediaProps = { id?: string; alt?: string; type?: string; url?: string; width?: number; height?: number };

/** Resolves every smart link locally: a card shows its URL (or issue key), and nothing is requested. */
class OfflineCardClient {
  async fetchData(url: string) {
    const key = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/.exec(url)?.[1];
    return { meta: { access: 'granted', visibility: 'public', definitionId: 'offline', auth: [] }, data: { '@context': { '@vocab': 'https://www.w3.org/ns/activitystreams#', atlassian: 'https://schema.atlassian.com/ns/vocabulary#', schema: 'http://schema.org/' }, '@type': 'Object', name: key ?? url, url } };
  }
  async fetchDataAris() { return []; }
  async postData(): Promise<never> { throw new Error('offline'); }
  async prefetchData(url: string) { return this.fetchData(url); }
  async search() { return { meta: { access: 'granted', visibility: 'public' }, data: { items: [] } }; }
  async fetchAvailableSearchProviders() { return []; }
}
const cardClient = new OfflineCardClient();

const MediaContext = React.createContext<{ media: Media; src(id: string): string | undefined }>({ media: {}, src: () => undefined });

/** An image or file of the document: through the app's proxy when it is an attachment we know, else a labelled placeholder. Never a remote URL. */
function MediaNode(props: MediaProps) {
  const { media, src } = React.useContext(MediaContext);
  const [failed, setFailed] = useState(false);
  const known = props.id ? media[props.id] : undefined;
  const name = known?.name ?? props.alt ?? (props.type === 'external' ? props.url : undefined) ?? 'Attachment';
  const url = props.id && known?.download && (!known.mediaType || known.mediaType.startsWith('image/')) ? src(props.id) : undefined;
  if (url && !failed) return <img className="adf-media" src={url} alt={name} loading="lazy" width={props.width} height={props.height} onError={() => setFailed(true)}/>;
  return <span className="adf-media-placeholder" role="img" aria-label={`${props.type === 'external' ? 'External image' : 'Attachment'}: ${name}`}>
    <span aria-hidden="true">{props.type === 'external' ? '🔗' : '📎'}</span> {name}{failed ? ' (couldn’t load)' : props.type === 'external' ? ' (external images are not loaded)' : ''}
  </span>;
}
const nodeComponents = { media: MediaNode, mediaInline: MediaNode };

const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
/** Light or dark, following the app (the system setting). */
function useColorMode() {
  const [mode, setMode] = useState<'light' | 'dark'>(() => dark() ? 'dark' : 'light');
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setMode(query.matches ? 'dark' : 'light');
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);
  return mode;
}

class Boundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Renders one Atlassian document as Jira or Confluence would. */
export default function AdfView({ document, media, mediaSrc, fallback }: { document: unknown; media: Media; mediaSrc(id: string): string | undefined; fallback: React.ReactNode }) {
  const mode = useColorMode();
  const [themed, setThemed] = useState(false);
  useEffect(() => {
    let live = true;
    void setGlobalTheme({ colorMode: mode, light: 'light', dark: 'dark', spacing: 'spacing', typography: 'typography' }).then(() => { if (live) setThemed(true); }, () => { if (live) setThemed(true); });
    return () => { live = false; };
  }, [mode]);
  const context = React.useMemo(() => ({ media, src: mediaSrc }), [media, mediaSrc]);
  if (!themed) return <p className="preview-empty muted">Loading…</p>;
  return <Boundary fallback={fallback}>
    <IntlProvider locale={navigator.language || 'en'} defaultLocale="en" onError={() => {}}>
      <SmartCardProvider client={cardClient as never}>
        <MediaContext.Provider value={context}>
          <div className="adf-view" data-color-mode={mode}>
            <ReactRenderer document={document as DocNode} appearance="full-page" nodeComponents={nodeComponents} media={{ allowLinking: false }} eventHandlers={{}} allowCopyToClipboard={false} allowHeadingAnchorLinks={false} allowAnnotations={false} />
          </div>
        </MediaContext.Provider>
      </SmartCardProvider>
    </IntlProvider>
  </Boundary>;
}
