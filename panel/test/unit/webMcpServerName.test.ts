import { describe, expect, it } from 'vitest';
import { mcpServerName } from '../../web/src/lib/mcpServerName.js';

/**
 * The name the MCP page's snippets give this panel in an AI app. Two panels have to come out
 * different, or the second one's `claude mcp add` is refused and its JSON replaces the first's.
 */

describe("a panel's name in an AI app", () => {
  it("is wpl7- and whose the domain is, without the words every panel's domain has", () => {
    expect(mcpServerName('https://panel.agency.com/mcp')).toBe('wpl7-agency');
    expect(mcpServerName('https://agency.com/mcp')).toBe('wpl7-agency');
    expect(mcpServerName('https://wp.agency.com/mcp')).toBe('wpl7-agency');
    expect(mcpServerName('https://www.panel.agency.com/mcp')).toBe('wpl7-agency');
    expect(mcpServerName('https://PANEL.Agency.COM/mcp')).toBe('wpl7-agency');
    expect(mcpServerName('https://panel.agency.co.uk/mcp')).toBe('wpl7-agency');
    expect(mcpServerName('https://panel.agency.com.au/mcp')).toBe('wpl7-agency');
  });

  it('keeps what tells two panels of one owner apart', () => {
    expect(mcpServerName('https://staging.agency.com/mcp')).toBe('wpl7-staging-agency');
    expect(mcpServerName('https://panel.eu.agency.com/mcp')).toBe('wpl7-eu-agency');
    expect(mcpServerName('https://panel.my-agency.com/mcp')).toBe('wpl7-my-agency');
    // `co` is dropped only as the second level under a country's domain, as in co.uk.
    expect(mcpServerName('https://panel.agency.co/mcp')).toBe('wpl7-agency');
    expect(mcpServerName('https://co.agency.io/mcp')).toBe('wpl7-co-agency');
  });

  it('takes the whole of an address, and of a name with no domain', () => {
    expect(mcpServerName('http://localhost:5173/mcp')).toBe('wpl7-localhost');
    expect(mcpServerName('https://203.0.113.5/mcp')).toBe('wpl7-203-0-113-5');
  });

  it('is plain wpl7 where the domain says nothing else', () => {
    expect(mcpServerName('https://panel.wpl7.com/mcp')).toBe('wpl7');
  });

  it('fits a shell command and a tool name as it is', () => {
    for (const url of ['https://panel.bücher.de/mcp', 'https://a--b.example.com/mcp', 'http://[::1]:3000/mcp']) {
      expect(mcpServerName(url), url).toMatch(/^wpl7(-[a-z0-9]+)*$/);
    }
  });
});
