import React, { useMemo } from 'react';
import { looksLikeUrl, nodesText, parseTitle, shortUrl, type TitleNode } from 'ai-sdk-letta/title';

/**
 * A conversation title as one line of inline Markdown: links, bold, italic
 * and code. Links open in a new tab without a referrer; links other than
 * http(s) and mailto render as their text. With `shortUrls`, a link whose
 * text is a URL shows a shortened URL (the full one is its tooltip).
 * `linkTabIndex={-1}` keeps links out of the tab order (the sidebar row is
 * one tab stop).
 */
export function TitleView({ title, shortUrls = false, linkTabIndex }: { title: string; shortUrls?: boolean; linkTabIndex?: number }) {
  const nodes = useMemo(() => parseTitle(title), [title]);
  return <>{render(nodes, { shortUrls, linkTabIndex })}</>;
}

type Options = { shortUrls: boolean; linkTabIndex?: number };

function render(nodes: readonly TitleNode[], options: Options): React.ReactNode[] {
  return nodes.map(node => {
    const key = node.start;
    switch (node.type) {
      case 'text': return <React.Fragment key={key}>{node.value}</React.Fragment>;
      case 'code': return <code key={key} className="title-code">{node.value}</code>;
      case 'strong': return <strong key={key}>{render(node.children, options)}</strong>;
      case 'emphasis': return <em key={key}>{render(node.children, options)}</em>;
      case 'image': return <React.Fragment key={key}>{node.alt}</React.Fragment>;
      case 'link': {
        const text = nodesText(node.children);
        const label = options.shortUrls && looksLikeUrl(text) ? shortUrl(text) : undefined;
        const children = label ?? render(node.children, options);
        if (!node.href) return <span key={key} className="title-inert">{children}</span>;
        return <a key={key} className="title-link" href={node.href} target="_blank" rel="noopener noreferrer" title={node.href} tabIndex={options.linkTabIndex}
          // The row's own click (open the conversation) must not also fire.
          onClick={event => event.stopPropagation()}>{children}</a>;
      }
    }
  });
}
