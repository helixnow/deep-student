use std::collections::BTreeSet;

use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::visit::{self, Visit};
use syn::{Macro, Path, Token};

pub fn extract_registered_commands(source: &str) -> Result<BTreeSet<String>, String> {
    let file = syn::parse_file(source).map_err(|error| format!("invalid Rust source: {error}"))?;
    let mut visitor = GenerateHandlerVisitor::default();
    visitor.visit_file(&file);

    if !visitor.errors.is_empty() {
        return Err(visitor.errors.join("; "));
    }
    if visitor.invocations != 1 {
        return Err(format!(
            "expected exactly one generate_handler! invocation, found {}",
            visitor.invocations
        ));
    }
    if visitor.commands.is_empty() {
        return Err("generate_handler! command list is empty".to_string());
    }
    Ok(visitor.commands)
}

#[derive(Default)]
struct GenerateHandlerVisitor {
    commands: BTreeSet<String>,
    errors: Vec<String>,
    invocations: usize,
}

impl<'ast> Visit<'ast> for GenerateHandlerVisitor {
    fn visit_macro(&mut self, node: &'ast Macro) {
        if node
            .path
            .segments
            .last()
            .is_some_and(|segment| segment.ident == "generate_handler")
        {
            self.invocations += 1;
            let parser = Punctuated::<Path, Token![,]>::parse_terminated;
            match parser.parse2(node.tokens.clone()) {
                Ok(paths) => {
                    for path in paths {
                        let Some(segment) = path.segments.last() else {
                            self.errors.push("empty command path".to_string());
                            continue;
                        };
                        let name = segment.ident.to_string();
                        self.commands
                            .insert(name.strip_prefix("r#").unwrap_or(&name).to_string());
                    }
                }
                Err(error) => self
                    .errors
                    .push(format!("invalid generate_handler! command list: {error}")),
            }
        }

        visit::visit_macro(self, node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_all_rust_path_forms() {
        let source = r#"
            use crate::commands::imported_command;

            fn configure(app: tauri::Builder) {
                // tauri::generate_handler![ignored_comment]
                let _text = "tauri::generate_handler![ignored_string]";
                app.invoke_handler(tauri::generate_handler![
                    crate::commands::crate_command,
                    self::commands::self_command,
                    super::commands::super_command,
                    imported_command,
                    ::absolute::absolute_command,
                ]);
            }
        "#;

        let actual = extract_registered_commands(source).unwrap();
        let expected: BTreeSet<String> = [
            "absolute_command",
            "crate_command",
            "imported_command",
            "self_command",
            "super_command",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_non_path_entries_instead_of_silently_dropping_them() {
        let source = "fn configure() { tauri::generate_handler![crate::ok, make_command()]; }";
        assert!(extract_registered_commands(source)
            .unwrap_err()
            .contains("invalid generate_handler! command list"));
    }
}
