import { describe, expect, it } from "vitest";
import { extractPythonImports, resolvePythonImport } from "./python.js";

describe("extractPythonImports", () => {
  it("reads plain, aliased and multi-name imports", async () => {
    const imports = await extractPythonImports("import os\nimport shop.orders.service as svc, json\n");
    expect(imports).toEqual([
      { module: "os", level: 0, names: [], line: 1 },
      { module: "shop.orders.service", level: 0, names: [], line: 2 },
      { module: "json", level: 0, names: [], line: 2 },
    ]);
  });

  it("reads from-imports, relative levels, parentheses and wildcards", async () => {
    const src = [
      "from shop.payments.gateway import charge, refund as r",
      "from .models import (",
      "    Order,",
      ")",
      "from .. import storage",
      "from ..storage.db import *",
    ].join("\n");
    expect(await extractPythonImports(src)).toEqual([
      { module: "shop.payments.gateway", level: 0, names: ["charge", "refund"], line: 1 },
      { module: "models", level: 1, names: ["Order"], line: 2 },
      { module: "", level: 2, names: ["storage"], line: 5 },
      { module: "storage.db", level: 2, names: ["*"], line: 6 },
    ]);
  });

  it("finds imports nested in functions and conditionals", async () => {
    const src = "def f():\n    from shop.storage import db\n\nif TYPE_CHECKING:\n    import shop.orders\n";
    expect((await extractPythonImports(src)).map((i) => i.line)).toEqual([2, 5]);
  });

  it("still returns imports from a file with syntax errors", async () => {
    const imports = await extractPythonImports("import shop.api\ndef broken(:\n");
    expect(imports[0]?.module).toBe("shop.api");
  });
});

describe("resolvePythonImport", () => {
  const files = new Set([
    "src/shop/__init__.py",
    "src/shop/orders/__init__.py",
    "src/shop/orders/models.py",
    "src/shop/orders/service.py",
    "src/shop/storage/__init__.py",
    "src/shop/storage/db.py",
    "tools/report.py",
  ]);
  const roots = ["src", "."];
  const from = "src/shop/orders/service.py";

  it("resolves absolute modules and packages from the roots", () => {
    expect(resolvePythonImport({ module: "shop.storage.db", level: 0, names: [], line: 1 }, from, files, roots)).toEqual([
      "src/shop/storage/db.py",
    ]);
    expect(resolvePythonImport({ module: "shop.orders", level: 0, names: [], line: 1 }, from, files, roots)).toEqual([
      "src/shop/orders/__init__.py",
    ]);
    expect(resolvePythonImport({ module: "tools.report", level: 0, names: [], line: 1 }, from, files, roots)).toEqual([
      "tools/report.py",
    ]);
  });

  it("prefers a submodule over a package attribute in from-imports", () => {
    expect(resolvePythonImport({ module: "shop.storage", level: 0, names: ["db"], line: 1 }, from, files, roots)).toEqual([
      "src/shop/storage/db.py",
    ]);
    expect(resolvePythonImport({ module: "shop.orders.models", level: 0, names: ["Order"], line: 1 }, from, files, roots)).toEqual([
      "src/shop/orders/models.py",
    ]);
  });

  it("resolves relative imports from the importing file's package", () => {
    expect(resolvePythonImport({ module: "models", level: 1, names: ["Order"], line: 1 }, from, files, roots)).toEqual([
      "src/shop/orders/models.py",
    ]);
    expect(resolvePythonImport({ module: "", level: 2, names: ["storage"], line: 1 }, from, files, roots)).toEqual([
      "src/shop/storage/__init__.py",
    ]);
  });

  it("returns nothing for the standard library and third-party packages", () => {
    expect(resolvePythonImport({ module: "uuid", level: 0, names: [], line: 1 }, from, files, roots)).toEqual([]);
    expect(resolvePythonImport({ module: "requests", level: 0, names: ["get"], line: 1 }, from, files, roots)).toEqual([]);
  });

  it("does not resolve above the repo root", () => {
    expect(resolvePythonImport({ module: "x", level: 9, names: [], line: 1 }, from, files, roots)).toEqual([]);
  });
});
