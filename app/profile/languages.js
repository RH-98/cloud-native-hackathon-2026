// What people type for a programming language -> its display name.
// Shared by the typed-interests path and the LinkedIn paste parser.
const LANGUAGES = {
  go: 'Go', golang: 'Go', rust: 'Rust', python: 'Python', py: 'Python', java: 'Java', typescript: 'TypeScript',
  ts: 'TypeScript', javascript: 'JavaScript', js: 'JavaScript', node: 'JavaScript', nodejs: 'JavaScript', c: 'C',
  'c++': 'C++', cpp: 'C++', 'c#': 'C#', csharp: 'C#', dotnet: 'C#', ruby: 'Ruby', kotlin: 'Kotlin', swift: 'Swift',
  scala: 'Scala', elixir: 'Elixir', haskell: 'Haskell', php: 'PHP', shell: 'Shell', bash: 'Shell', zig: 'Zig',
  lua: 'Lua', dart: 'Dart', clojure: 'Clojure', ocaml: 'OCaml', erlang: 'Erlang', julia: 'Julia',
};

function languageOf(phrase) {
  const key = String(phrase).trim().toLowerCase();
  return Object.hasOwn(LANGUAGES, key) ? LANGUAGES[key] : undefined;
}

module.exports = { LANGUAGES, languageOf };
