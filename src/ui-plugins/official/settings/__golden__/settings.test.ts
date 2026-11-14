// @vitest-environment node
import { describe, expect, it } from 'vitest';
import golden from './settings.json';
import React from 'react';
import ts from 'typescript';
import * as icons from '@phosphor-icons/react';
import type { TFunction } from 'i18next';
import { UiKernel } from '@/ui-kernel/kernel';
import type { SettingsSection, SettingsSectionPropsFactories } from '@/ui-kernel/contracts/settings';
import type { SlotEntry } from '@/ui-kernel/slots';
import settingsPlugin from '../index';
import { settingsNavigation } from '../navigation';
import { SectionContent } from '../SectionContent';
import { lazyBoundaries, settingsPath, sourceFile } from './legacy';

const t = ((key: string) => key) as TFunction;
const normalize = (text: string) => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(token === ts.SyntaxKind.StringLiteral ? JSON.stringify(scanner.getTokenValue()) : scanner.getTokenText());
  }
  return tokens.join(' ');
};

function value(node: ts.JsxAttributeValue | ts.Expression, source: ts.SourceFile): string | boolean {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isJsxExpression(node)) return normalize(node.expression!.getText(source));
  return normalize(node.getText(source));
}

/** Read the real shell's factories: compare every expression/callback with pre-F1 JSX. */
function shellProps() {
  const source = sourceFile(settingsPath);
  const result: Record<string, () => Record<string, unknown>> = {};
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'sectionProps') {
      const object = node.initializer as ts.ObjectLiteralExpression;
      for (const property of object.properties as ts.NodeArray<ts.PropertyAssignment>) {
        const tab = property.name.getText(source).replace(/['"]/g, '');
        const factory = property.initializer as ts.ArrowFunction;
        const props = (factory.body as ts.ParenthesizedExpression).expression as ts.ObjectLiteralExpression;
        result[tab] = () => Object.fromEntries(props.properties.map((prop) => {
          if (ts.isShorthandPropertyAssignment(prop)) return [prop.name.text, prop.name.text];
          const assignment = prop as ts.PropertyAssignment;
          return [assignment.name.getText(source), value(assignment.initializer, source)];
        }));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result as unknown as SettingsSectionPropsFactories;
}

interface Shape { type: string; props: Record<string, unknown>; children: (Shape | string)[] }
function legacyShape(jsx: string): Shape {
  const source = ts.createSourceFile('branch.tsx', jsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function shape(node: ts.Node): Shape | string | undefined {
    if (ts.isJsxText(node)) return node.text.trim() || undefined;
    if (ts.isJsxExpression(node)) {
      const match = /^t\('([^']+)'\)$/.exec(node.expression!.getText(source));
      if (!match) throw new Error(`Unexpected golden child ${node.getText(source)}`);
      return match[1];
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const element = ts.isJsxElement(node) ? node.openingElement : node;
      return { type: element.tagName.getText(source),
        props: Object.fromEntries(element.attributes.properties.map((attr: ts.JsxAttribute) =>
          [attr.name.getText(source), attr.initializer ? value(attr.initializer, source) : true])),
        children: ts.isJsxElement(node) ? node.children.map(shape).filter((child) => child !== undefined) : [],
      };
    }
    throw new Error(`Unexpected golden node ${node.kind}`);
  }
  return shape((source.statements[0] as ts.ExpressionStatement).expression) as Shape;
}

function renderedShape(node: React.ReactNode): Shape | string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  const element = node as React.ReactElement;
  if (typeof element.type === 'function') return renderedShape(element.type(element.props));
  let type: string;
  if (typeof element.type === 'string') type = element.type;
  else {
    const lazy = element.type as unknown as { _payload: { _status: number; _result: () => unknown } };
    // Inspect the factory without calling it: registration/render selection must not preload pages.
    expect(lazy._payload._status).toBe(-1);
    const factory = lazy._payload._result.toString();
    type = golden.lazy.find((boundary) => factory.includes(`module.${boundary.export}`))?.name ?? factory;
  }
  const { children, ...props } = element.props;
  return { type, props, children: React.Children.toArray(children).map(renderedShape).filter((child) => child !== null) };
}

function navigationSnapshot(entries: readonly SlotEntry<SettingsSection>[], isMobile: boolean) {
  const iconNames = new Map(Object.entries(icons).map(([name, icon]) => [icon, name]));
  // Phosphor exports canonical and *Icon aliases; the old file uses the canonical names.
  for (const [name, icon] of Object.entries(icons)) if (!name.endsWith('Icon')) iconNames.set(icon, name);
  return JSON.parse(JSON.stringify(settingsNavigation(entries, t, { isMobile }), (key, item) =>
    key === 'icon' ? iconNames.get(item) : item));
}

describe('settings extension-point golden (UiKernel slot after F1)', () => {
  it('matches all fields of the original navigation, content outcomes and lazy boundaries', async () => {
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    try {
      const entries = kernel.slots.list<SettingsSection>('settings.sections');
      const sections = entries.map((entry) => entry.value);
      expect(entries.every((entry) => entry.owner === 'dstu.ui.settings')).toBe(true);
      expect(entries.every((entry) => entry.origin === 'builtin')).toBe(true);
      expect(sections.map((section) => section.id)).toEqual(golden.tabs);
      expect(lazyBoundaries('src/ui-plugins/official/settings/sections.tsx')).toEqual(golden.lazy);
      expect(lazyBoundaries(settingsPath)).toEqual([]);
      expect(navigationSnapshot(entries, false)).toEqual(golden.navigation.desktop);
      expect(navigationSnapshot(entries, true)).toEqual(golden.navigation.mobile);

      const getProps = shellProps();
      expect(Object.keys(getProps)).toEqual(golden.tabs);
      const expectedShapes = golden.content.map((branch) => legacyShape(branch.jsx));
      for (const testCase of golden.cases) {
        const { isMobile } = testCase.input;
        const actual = entries.map((entry) => {
          const shape = renderedShape(SectionContent({ entry, getProps, isMobile, t }));
          return { tab: entry.key,
            branches: shape === null ? [] : [expectedShapes.findIndex((expected) =>
              JSON.stringify(expected) === JSON.stringify(shape))],
            redirect: entry.value.redirect?.({ isMobile }) ?? null,
          };
        });
        expect(actual, JSON.stringify(testCase.input)).toEqual(testCase.content);
      }
    } finally {
      await kernel.dispose();
    }
  });
});
