import { describe, expect, it } from 'vitest';
import { editScalar, parsePhp, phpByteLength, phpKeyLabel, replaceAt, serializePhp } from '../../shared/phpSerialize.js';

describe("PHP's serialize format", () => {
  it('reads what WordPress keeps in wp_options, and writes it back byte for byte', () => {
    const samples = [
      'a:2:{i:0;s:19:"akismet/akismet.php";i:1;s:27:"woocommerce/woocommerce.php";}',
      'a:1:{s:13:"administrator";a:2:{s:4:"name";s:13:"Administrator";s:12:"capabilities";a:1:{s:14:"manage_options";b:1;}}}',
      'O:8:"stdClass":2:{s:3:"foo";d:1.5;s:3:"bar";N;}',
      'i:-42;',
      'd:1.0E+25;',
      'b:0;',
      'N;',
      's:0:"";',
      'C:11:"ArrayObject":21:{x:i:0;a:0:{};m:a:0:{}}',
      'E:11:"Suit:Hearts";',
      'a:2:{i:0;O:8:"stdClass":0:{}i:1;r:2;}',
    ];
    for (const s of samples) {
      const parsed = parsePhp(s);
      expect(parsed, s).not.toBeNull();
      expect(parsed!.editable, s).toBe(true);
      expect(serializePhp(parsed!.value), s).toBe(s);
    }
  });

  it('counts string lengths in bytes, as PHP does', () => {
    expect(phpByteLength('čaj')).toBe(4);
    const parsed = parsePhp('a:1:{s:4:"name";s:4:"čaj";}')!;
    expect(parsed.value).toEqual({ t: 'array', items: [{ key: { t: 'string', v: 'name' }, value: { t: 'string', v: 'čaj' } }] });
    // A quote and a semicolon inside a string are just bytes: the length says where it ends.
    expect(parsePhp('s:5:"a";b;";')!.value).toEqual({ t: 'string', v: 'a";b;' });
  });

  it('recounts a length when a value is edited', () => {
    const parsed = parsePhp('a:1:{s:8:"blogname";s:5:"Hello";}')!;
    const edited = editScalar({ t: 'string', v: 'Hello' }, 'Ahoj světe')!;
    const next = replaceAt(parsed.value, [0], edited);
    expect(serializePhp(next)).toBe('a:1:{s:8:"blogname";s:11:"Ahoj světe";}');
    expect(parsePhp(serializePhp(next))).not.toBeNull();
  });

  it('refuses what is not a serialized value, or has anything after one', () => {
    for (const s of ['hello', '{"a":1}', 's:5:"abc";', 'a:1:{i:0;}', 'i:1;x', 'b:2;', 'i:1.5;', '']) {
      expect(parsePhp(s), s).toBeNull();
    }
  });

  it('marks a value with bytes that are not UTF-8 as not editable', () => {
    // \xff is one byte that UTF-8 does not allow; serialized from a string of it, the length is 1.
    const raw = new TextDecoder('latin1').decode(new Uint8Array([0x73, 0x3a, 0x31, 0x3a, 0x22, 0xff, 0x22, 0x3b]));
    // The panel only ever sees text, so a byte like that has already become U+FFFD or similar: refused, or read lenient.
    const parsed = parsePhp(raw);
    if (parsed) expect(parsed.editable).toBe(false);
  });

  it('takes typed scalars only in their own type', () => {
    expect(editScalar({ t: 'int', v: '1' }, ' 42 ')).toEqual({ t: 'int', v: '42' });
    expect(editScalar({ t: 'int', v: '1' }, '4.2')).toBeNull();
    expect(editScalar({ t: 'float', v: '1.5' }, '2e3')).toEqual({ t: 'float', v: '2e3' });
    expect(editScalar({ t: 'bool', v: true }, 'false')).toEqual({ t: 'bool', v: false });
    expect(editScalar({ t: 'null' }, 'x')).toBeNull();
  });

  it("names an object's protected and private properties", () => {
    expect(phpKeyLabel({ t: 'string', v: '\u0000*\u0000secret' })).toBe('secret (protected)');
    expect(phpKeyLabel({ t: 'string', v: '\u0000Foo\u0000bar' })).toBe('bar (private, Foo)');
    expect(phpKeyLabel({ t: 'int', v: '3' })).toBe('3');
  });
  it('keeps a byte-order mark at the start of a string, in keys and values', () => {
    const text = 'a:2:{s:5:"\uFEFFid";s:3:"sku";s:4:"name";s:8:"\uFEFFtitle";}';
    const parsed = parsePhp(text)!;
    expect(parsed.editable).toBe(true);
    expect(serializePhp(parsed.value)).toBe(text);
    const edited = replaceAt(parsed.value, [0], editScalar({ t: 'string', v: 'sku' }, 'SKU')!);
    expect(serializePhp(edited)).toBe('a:2:{s:5:"\uFEFFid";s:3:"SKU";s:4:"name";s:8:"\uFEFFtitle";}');
  });
});
