# Repository Guidelines

This client manages and syncs Chromium and Firefox bookmarks across browsers (with an Android companion), so keep cross-platform impacts front of mind when contributing.

## Project Structure & Module Organization
The client code lives in src, with AngularJS feature modules under src/modules (for example pp, shared, webext). Shared styles reside in src/styles, while reusable typings are in src/@types. Platform assets are grouped in es (es/android Cordova project, es/webext extension artefacts, localized strings in es/strings). Build artefacts land in uild/<platform> and packaged releases in dist. Webpack configs for Chromium, Firefox, and Android builds are stored in webpack/.

## Build, Test & Development Commands
- 
pm run build:chromium|firefox|android ? lint, rebuild, and emit production bundles to uild/<platform>.
- 
pm run watch:<platform> ? run the development build with watch mode for rapid iteration.
- 
pm run lint / 
pm run lint:fix ? check (and optionally auto-fix) TypeScript and SCSS rules.
- 
pm test ? execute Jest unit tests with coverage reports targeting src/modules.
- 
pm run package:<platform> ? create distributable archives in dist/ after updating the build number.

## Coding Style & Naming Conventions
TypeScript follows the ESLint + Prettier settings in package.json: 2-space indentation, 120 character line width, single quotes, and required semicolons. Keep AngularJS artifacts in kebab-cased directories with suffixed filenames (*.controller.ts, *.module.ts, *.service.ts). SCSS is linted by Stylelint (standard-scss + Prettier); prefer BEM-like class names and place shared mixins under src/styles. Run 
pm run lint:fix before submitting.

## Testing Guidelines
Unit tests use Jest with 	s-jest and live beside source as *.spec.ts. Aim to cover new logic in src/modules; when stubbing browser APIs, reuse helpers from src/test. Run 
pm test -- --watch while developing and confirm coverage deltas in the generated coverage/ folder before opening a PR.

## Commit & Pull Request Guidelines
Recent commits favour concise, imperative summaries (e.g. disable webapp update); follow that format and limit subject lines to ~70 characters. Reference linked issues in the body when relevant. For pull requests, include: a short purpose statement, key platform(s) affected, testing notes or screenshots for UI changes, and any localisation updates touched. Ensure lint and test commands pass locally and mention the commands run in the PR description.

## Localization & Release Notes
Update translation keys in es/strings via Crowdin exports, and document externally visible changes in CHANGELOG.md when applicable. Fastlane metadata under astlane/ should be updated when Android release details change.
