# Pylez

Pylez provide open and rich language support for python and notebook based on Pyright.

## Feature

- [x] Notebook support
- [x] Semantic highlight
- [ ] docstrings for built-in/standard library modules
- [ ] refactoring code actions

## Usage

### VSCode extension

You can use Pylez on IDE like VSCode, Code – OSS(and all its fork), Theia, Opensumi etc.

- download from [vscode marketplace](https://marketplace.visualstudio.com/items?itemName=ryannz.pylez)
- download from [openvsx](https://open-vsx.org/extension/ryannz/pylez)

When you have python extension installed, you should add following setting to your `settings.json` file:
```json
 { "python.languageServer": "None"}
```


### npm package

For other editor users, you can use the npm package to start LSP server.
In [Libro](https://github.com/difizen/libro), we use Pylez npm package with jupyter-lsp to procide LSP service.

```sh
npm i @difizen/pylez
```
