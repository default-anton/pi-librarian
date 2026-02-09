import assert from "node:assert/strict";
import test from "node:test";

import type { AuthSource } from "./model-selection.ts";
import { getSmallModelFromProvider } from "./model-selection.ts";

type Model = { provider: string; id: string };

type RegistryOptions = {
  authSource?: AuthSource;
  usingOAuth?: boolean;
};

function makeRegistry(models: Model[], options: RegistryOptions = {}) {
  return {
    getAvailable() {
      return models;
    },
    getAuthSource() {
      return options.authSource ?? "none";
    },
    isUsingOAuth() {
      return options.usingOAuth ?? false;
    },
  };
}

test("oauth mode prefers google-antigravity/gemini-3-flash", () => {
  const models: Model[] = [
    { provider: "google-antigravity", id: "gemini-3-flash" },
    { provider: "google-vertex", id: "gemini-3-flash-preview" },
  ];

  const selected = getSmallModelFromProvider(
    makeRegistry(models, { authSource: "oauth", usingOAuth: true }),
    { provider: "openai-codex", id: "gpt-5.3-codex" },
  );

  assert.ok(selected);
  assert.equal(selected.model.provider, "google-antigravity");
  assert.equal(selected.model.id, "gemini-3-flash");
  assert.equal(selected.authMode, "oauth");
  assert.equal(selected.authSource, "oauth");
});

test("api-key mode prefers google-vertex gemini-3-flash family", () => {
  const models: Model[] = [
    { provider: "google-vertex", id: "gemini-3-flash-preview" },
    { provider: "google", id: "gemini-3-flash-preview" },
  ];

  const selected = getSmallModelFromProvider(
    makeRegistry(models, { authSource: "api_key" }),
    { provider: "openai", id: "gpt-5.1-codex" },
  );

  assert.ok(selected);
  assert.equal(selected.model.provider, "google-vertex");
  assert.equal(selected.model.id, "gemini-3-flash-preview");
  assert.equal(selected.authMode, "api-key");
  assert.equal(selected.authSource, "api_key");
});

test("api-key mode falls back to google gemini when vertex missing", () => {
  const models: Model[] = [{ provider: "google", id: "gemini-3-flash-preview" }];

  const selected = getSmallModelFromProvider(
    makeRegistry(models, { authSource: "env" }),
    { provider: "anthropic", id: "claude-opus-4-6" },
  );

  assert.ok(selected);
  assert.equal(selected.model.provider, "google");
  assert.equal(selected.model.id, "gemini-3-flash-preview");
  assert.equal(selected.authMode, "api-key");
  assert.equal(selected.authSource, "env");
});

test("fallback prefers current provider haiku 4.5", () => {
  const models: Model[] = [{ provider: "anthropic", id: "claude-haiku-4-5" }];

  const selected = getSmallModelFromProvider(
    makeRegistry(models, { authSource: "api_key" }),
    { provider: "anthropic", id: "claude-opus-4-6" },
  );

  assert.ok(selected);
  assert.equal(selected.model.provider, "anthropic");
  assert.equal(selected.model.id, "claude-haiku-4-5");
  assert.equal(selected.thinkingLevel, "low");
});

test("fallback uses current model with low thinking", () => {
  const models: Model[] = [{ provider: "openai", id: "gpt-5.1-codex" }];

  const selected = getSmallModelFromProvider(
    makeRegistry(models, { authSource: "runtime" }),
    { provider: "openai", id: "gpt-5.1-codex" },
  );

  assert.ok(selected);
  assert.equal(selected.model.provider, "openai");
  assert.equal(selected.model.id, "gpt-5.1-codex");
  assert.equal(selected.thinkingLevel, "low");
});

test("when current model is missing, defaults to api-key policy with explicit reason", () => {
  const models: Model[] = [{ provider: "google", id: "gemini-3-flash-preview" }];

  const selected = getSmallModelFromProvider(makeRegistry(models, { authSource: "oauth" }), undefined);

  assert.ok(selected);
  assert.equal(selected.authMode, "api-key");
  assert.equal(selected.authSource, "none");
  assert.match(selected.reason, /no current model/i);
});

test("falls back to isUsingOAuth on older model registries", () => {
  const models: Model[] = [
    { provider: "google-antigravity", id: "gemini-3-flash" },
    { provider: "openai", id: "gpt-5.1-codex" },
  ];

  const legacyRegistry = {
    getAvailable() {
      return models;
    },
    isUsingOAuth() {
      return true;
    },
  };

  const selected = getSmallModelFromProvider(legacyRegistry, { provider: "openai", id: "gpt-5.1-codex" });

  assert.ok(selected);
  assert.equal(selected.authMode, "oauth");
  assert.equal(selected.authSource, "oauth");
  assert.equal(selected.model.provider, "google-antigravity");
});
