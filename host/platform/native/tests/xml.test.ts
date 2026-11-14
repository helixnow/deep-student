import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import type { MindmapXmlNode, MindmapXmlParser } from '../xml/api.ts';
import { mindmapXml } from '../xml/index.ts';

/**
 * Oracle: roxmltree 0.20.0 `Document::parse` (default `ParsingOptions`), as called by
 * `builtin_resource_executor.rs:3252,3437,3822,3944`.  Expected trees/errors are copied
 * from the crate's own corpus `roxmltree-0.20.0/tests/files/<name>.{xml,yaml}` (only
 * files without `<!DOCTYPE`, whose result does not depend on the corpus' `allow_dtd`),
 * and Display strings from `src/parse.rs:186-275`.
 */
type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
let xml: MindmapXmlParser;
beforeAll(async () => { host = await createTestHost({ plugins: [native] }); xml = host.ctx.mindmapXml; });
afterAll(async () => { await host.dispose(); });

const text = (value: string): MindmapXmlNode => ({ kind: 'text', localName: '', attributes: [], children: [], text: value });
const other = (): MindmapXmlNode => ({ kind: 'other', localName: '', attributes: [], children: [], text: null });
const element = (localName: string, children: MindmapXmlNode[] = [],
  attributes: MindmapXmlNode['attributes'] = []): MindmapXmlNode => ({
  kind: 'element', localName, attributes, children,
  text: children[0]?.kind === 'text' ? children[0].text : null,
});
const parseError = (input: string): string => {
  try { xml.parse(input); } catch (error) { expect(error).toBeInstanceOf(Error); return (error as Error).message; }
  throw new Error('expected roxmltree to reject the document');
};

describe('mindmapXml provider (roxmltree 0.20.0 via WASI)', () => {
  it('is provided by dstu.native as a synchronous parser over the same WASI engine', () => {
    expect(xml).toBe(mindmapXml);
    const root = xml.parse('<r/>');
    expect(root).not.toBeInstanceOf(Promise);
    expect(root).toEqual(element('r'));
  });

  it('ParsingOptions::default allow_dtd=false: any <!DOCTYPE is Error::DtdDetected', () => {
    expect(parseError('<!DOCTYPE map>\n<map/>')).toBe('XML with DTD detected');
    expect(parseError('<?xml version="1.0"?>\n<!DOCTYPE opml [ <!ENTITY e "x"> ]>\n<opml>&e;</opml>')).toBe('XML with DTD detected');
  });

  it('CDATA merges into the adjacent text node (cdata_001, cdata_002, cdata_004, cdata_005)', () => {
    expect(xml.parse('<doc>\n<![CDATA[<greeting>Hello, world!</greeting>]]>\n</doc>\n'))
      .toEqual(element('doc', [text('\n<greeting>Hello, world!</greeting>\n')]));
    expect(xml.parse('<e><![CDATA[\n    <![CDATA[abc]]]>]&gt;<![CDATA[\n  ]]></e>\n'))
      .toEqual(element('e', [text('\n    <![CDATA[abc]]>\n  ')]));
    expect(xml.parse('<p>\n    some\n    <p>\n        <![CDATA[long]]>\n    </p>\n    text\n</p>\n'))
      .toEqual(element('p', [text('\n    some\n    '), element('p', [text('\n        long\n    ')]), text('\n    text\n')]));
    const merged = xml.parse('<p>T<![CDATA[e]]>x<![CDATA[t]]></p>\n');
    expect(merged.children).toHaveLength(1);
    expect(merged).toEqual(element('p', [text('Text')]));
  });

  it('process_cdata replaces carriage returns inside CDATA (parse.rs:1000-1027)', () => {
    expect(xml.parse('<r><![CDATA[a\r\nb\rc]]></r>')).toEqual(element('r', [text('a\nb\nc')]));
  });

  it('resolves predefined and character references in text and attributes (text_009, attrs_003, attrs_004)', () => {
    expect(xml.parse('<root>&#48;&#x64;&#x20;&gt;</root>\n')).toEqual(element('root', [text('0d >')]));
    expect(xml.parse("<p a='A&#x20;B'/>\n")).toEqual(element('p', [], [{ localName: 'a', namespace: null, value: 'A B' }]));
    expect(xml.parse("<p a='&#xd;&#xd;A&#xa;&#xa;B&#xd;&#xa;'/>\n"))
      .toEqual(element('p', [], [{ localName: 'a', namespace: null, value: '\r\rA\n\nB\r\n' }]));
  });

  it('keeps attribute namespaces and document order; xmlns declarations are not attributes (ns_002, ns_005, ns_007)', () => {
    expect(xml.parse("<svg xmlns='http://www.w3.org/2000/svg' a='b'/>\n"))
      .toEqual(element('svg', [], [{ localName: 'a', namespace: null, value: 'b' }]));
    expect(xml.parse("<svg xml:space='preserve'/>\n"))
      .toEqual(element('svg', [], [{ localName: 'space', namespace: 'http://www.w3.org/XML/1998/namespace', value: 'preserve' }]));
    expect(xml.parse("<e a:attr='a_ns' b:attr='b_ns' attr='no_ns' xmlns:b='http://www.ietf.org'\n    xmlns:a='http://www.w3.org' xmlns='http://www.uvic.ca'/>\n"))
      .toEqual(element('e', [], [
        { localName: 'attr', namespace: 'http://www.w3.org', value: 'a_ns' },
        { localName: 'attr', namespace: 'http://www.ietf.org', value: 'b_ns' },
        { localName: 'attr', namespace: null, value: 'no_ns' },
      ]));
  });

  it('returns root_element with text, comment and PI children in document order; the XML declaration and outer comments are dropped (tree_001, text_010)', () => {
    expect(xml.parse("<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<!-- comment1 -->\n<root>\n    <!-- comment2 -->\n    <?target value?>\n    <item/>\n    text\n</root>\n"))
      .toEqual(element('root', [text('\n    '), other(), text('\n    '), other(), text('\n    '), element('item'), text('\n    text\n')]));
    expect(xml.parse('<text>\n    <tspan>t</tspan>e\n    <tspan>x</tspan>t\n</text>\n'))
      .toEqual(element('text', [text('\n    '), element('tspan', [text('t')]), text('e\n    '), element('tspan', [text('x')]), text('t\n')]));
  });

  it('keeps roxmltree::Error Display text and TextPos (attrs_err, elems_err, entity_err, ns_err, tree_err)', () => {
    const vectors: Array<[string, string, string]> = [
      ['attrs_err_001', "<e a='b1' a='b2'/>\n", "attribute 'a' at 1:11 is already defined"],
      ['attrs_err_002', "<e xmlns:n1='http://www.w3.org' xmlns:n2='http://www.w3.org' n1:a='b1' n2:a='b2'/>\n", "attribute 'a' at 1:72 is already defined"],
      ['elems_err_001', '<root>\n    <item>\n</root>\n', "expected 'item' tag, not 'root' at 3:1"],
      ['elems_err_002', "<t:root xmlns:t='http://www.w3.org'>\n    <t:item>\n</t:root>\n", "expected 't:item' tag, not 't:root' at 3:1"],
      ['entity_err_001', "<e a='&d;'/>\n", "unknown entity reference 'd' at 1:7"],
      ['entity_err_007', '<p a="&amp"/>\n', 'malformed entity reference at 1:7'],
      ['entity_err_008', '<p>&amp</p>\n', 'malformed entity reference at 1:4'],
      ['ns_err_001', "<svg xmlns:xml='http://www.w3.org/XML/1998/namespace2'/>\n", "'xml' namespace prefix mapped to wrong URI at 1:6"],
      ['ns_err_004', "<svg xmlns:n='http://www.w3.org' xmlns:n='http://www.w3.org'/>\n", "namespace 'n' at 1:34 is already defined"],
      ['ns_err_010', '<a:e/>\n', "an unknown namespace prefix 'a' at 1:2"],
      ['ns_err_011', "<e xmlns='http://www.w3.org' test:a='b'/>\n", "an unknown namespace prefix 'test' at 1:30"],
      ['ns_err_012', "<root xmlns:n='http://www.w3.org'>\n    <n:item>\n    </item>\n</root>\n", "expected 'n:item' tag, not 'item' at 3:5"],
      ['tree_err_001', "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<!-- no root node -->\n", 'the document does not have a root node'],
      ['tree_err_002', "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<open>Text\n", 'the root node was opened but never closed'],
      ['tree_err_003', "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<root><open>Text</root>\n", "expected 'open' tag, not 'root' at 2:17"],
    ];
    for (const [name, input, message] of vectors) expect(parseError(input), name).toBe(message);
    // Error::NoRootNode for empty input (parse.rs:597-599), not an empty document.
    expect(parseError('')).toBe('the document does not have a root node');
  });

  it('keeps non-BMP text and attribute values (UTF-8 engine, UTF-16 host strings)', () => {
    expect(xml.parse('<n TEXT="数学😀"><b>根😀</b></n>'))
      .toEqual(element('n', [element('b', [text('根😀')])], [{ localName: 'TEXT', namespace: null, value: '数学😀' }]));
  });

  it('nesting depth: 3000 levels parse; deeper input overflows roxmltree\'s recursive tokenizer on the 1 MiB wasm stack (known deviation, SPEC WP-095)', () => {
    const nested = (depth: number) => `${'<o>'.repeat(depth)}x${'</o>'.repeat(depth)}`;
    let node = xml.parse(nested(3000));
    for (let level = 1; level < 3000; level += 1) node = node.children[0]!;
    expect(node).toEqual(element('o', [text('x')]));
    // tokenizer.rs parse_element -> parse_content recurses per level; native Rust aborts on
    // its own thread-stack overflow.  runWasmSync gives the guest a host stack large enough that
    // the guest's own 1 MiB stack runs out first on every CPU, so the call throws RuntimeError
    // (on the Host main thread's ~1 MB stack, macOS arm64 hit RangeError below 2500 levels).
    let overflow: unknown = null;
    try { xml.parse(nested(5000)); } catch (error) { overflow = error; }
    expect(overflow, String(overflow)).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(xml.parse('<r/>')).toEqual(element('r'));
  });

  it('parses the L13 mindmap_import sample documents (OPML / .mm / .xmind content.xml / .mmap Document.xml)', () => {
    const opml = xml.parse('<opml><body><outline text="Root"><outline text="Done" _complete="true" _note="note"/></outline></body></opml>');
    expect(opml).toEqual(element('opml', [element('body', [element('outline', [
      element('outline', [], [
        { localName: 'text', namespace: null, value: 'Done' },
        { localName: '_complete', namespace: null, value: 'true' },
        { localName: '_note', namespace: null, value: 'note' },
      ]),
    ], [{ localName: 'text', namespace: null, value: 'Root' }])])]));
    const mm = xml.parse('<map><node ID="a"><richcontent TYPE="NODE"><html><b>Rich</b> root</html></richcontent><node ID="b" TEXT="Child"><icon BUILTIN="button_ok"/></node><arrowlink DESTINATION="b" MIDDLE_LABEL="edge"/></node></map>');
    expect(mm).toEqual(element('map', [element('node', [
      element('richcontent', [element('html', [element('b', [text('Rich')]), text(' root')])], [{ localName: 'TYPE', namespace: null, value: 'NODE' }]),
      element('node', [element('icon', [], [{ localName: 'BUILTIN', namespace: null, value: 'button_ok' }])], [
        { localName: 'ID', namespace: null, value: 'b' }, { localName: 'TEXT', namespace: null, value: 'Child' },
      ]),
      element('arrowlink', [], [{ localName: 'DESTINATION', namespace: null, value: 'b' }, { localName: 'MIDDLE_LABEL', namespace: null, value: 'edge' }]),
    ], [{ localName: 'ID', namespace: null, value: 'a' }])]));
    const xmind = xml.parse('<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format" version="2.0"><sheet id="s"><topic id="a"><title>XML root</title><children><topics type="attached"><topic id="b"><title>Child</title></topic></topics></children></topic></sheet></xmap-content>');
    expect(xmind).toEqual(element('xmap-content', [element('sheet', [element('topic', [
      element('title', [text('XML root')]),
      element('children', [element('topics', [element('topic', [element('title', [text('Child')])], [{ localName: 'id', namespace: null, value: 'b' }])],
        [{ localName: 'type', namespace: null, value: 'attached' }])]),
    ], [{ localName: 'id', namespace: null, value: 'a' }])], [{ localName: 'id', namespace: null, value: 's' }])],
    [{ localName: 'version', namespace: null, value: '2.0' }]));
    const mmap = xml.parse('<ap:Map xmlns:ap="http://schemas.mindjet.com/MindManager/Application/2003"><ap:OneTopic><ap:Topic><ap:Text PlainText="MMap root"/></ap:Topic></ap:OneTopic></ap:Map>');
    expect(mmap).toEqual(element('Map', [element('OneTopic', [element('Topic', [
      element('Text', [], [{ localName: 'PlainText', namespace: null, value: 'MMap root' }]),
    ])])]));
  });
});
