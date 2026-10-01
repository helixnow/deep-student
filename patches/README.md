# Dependency patches

`@nvq+flowtoken+2.0.6.patch` keeps FlowToken's existing Markdown parser and text
animations, while loading `DefaultCode` only for a language code node. Ordinary
prose and inline code no longer load the syntax highlighter and Tabler icon
barrel. The pending code chunk displays the original code text. The unused
`docco` import is removed; FlowToken's `DefaultCode` already ignores `codeStyle`.

The patch targets the published CommonJS runtime. Its `import()` must remain a
native dynamic import so Vite can split the code renderer. `patch-package` runs
after installation, and the dependency is pinned to 2.0.6 so an upgrade cannot
silently bypass the patch. When upgrading, verify the prose/inline-code import
boundary, nested code blocks, animation, and code copying with
`FlowToken.lazyCode.test.tsx` and `MarkdownRenderer.flowtoken.test.tsx`.
