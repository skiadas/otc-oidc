import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**', '*.log'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Prefer brace-less single-statement control bodies when they fit on one
      // line; keep braces once a body spans multiple lines or has more than one
      // statement.
      curly: ['error', 'multi-line'],
    },
  },
);
