import { z } from "zod";
import { Agent, uid, coll } from "./base.js";

const init = (s) => coll(s, "pages", "fragments");

export const aemSites = new Agent({
  key: "aem_sites", name: "AEM Sites Agent", product: "Adobe Experience Manager Sites",
  description: "Pages, content fragments, authoring and publishing.",
  keywords: ["aem sites", "page", "content fragment", "fragment", "author", "publish", "component", "site", "landing"],
  tools: {
    create_page: { description: "Create a page under a path with a template and title.", shape: 1,
      schema: z.object({ path: z.string().regex(/^\/content\/[\w\-/]+$/, "path must start with /content/"), title: z.string(), template: z.string().default("page-content") }),
      run(a, s) { init(s); if ([...s.pages.values()].some((p) => p.path === a.path)) throw new Error(`Page exists at ${a.path}`);
        const v = { id: uid("pg"), ...a, components: [], status: "draft", version: 1 }; s.pages.set(v.id, v); return v; } },
    add_component: { description: "Author a component (text, image, teaser, fragment-ref) onto a page.", shape: 1,
      schema: z.object({ pageId: z.string(), type: z.enum(["text", "image", "teaser", "fragment"]), props: z.record(z.any()).default({}) }),
      run(a, s) { init(s); const p = s.pages.get(a.pageId); if (!p) throw new Error(`Unknown page '${a.pageId}'`);
        if (a.type === "fragment" && !s.fragments.has(a.props.fragmentId)) throw new Error("fragment component needs props.fragmentId of an existing fragment");
        p.components.push({ id: uid("cmpn"), type: a.type, props: a.props }); if (p.status === "published") p.status = "modified"; p.version++; return p; } },
    create_content_fragment: { description: "Create a structured content fragment from a model and element values.", shape: 1,
      schema: z.object({ name: z.string(), model: z.string(), elements: z.record(z.string()) }),
      run(a, s) { init(s); const v = { id: uid("cf"), ...a, status: "draft" }; s.fragments.set(v.id, v); return v; } },
    update_content_fragment: { description: "Update fragment elements (re-publish needed for live pages to change).", shape: 1,
      schema: z.object({ fragmentId: z.string(), elements: z.record(z.string()) }),
      run(a, s) { init(s); const f = s.fragments.get(a.fragmentId); if (!f) throw new Error(`Unknown fragment '${a.fragmentId}'`);
        Object.assign(f.elements, a.elements); if (f.status === "published") f.status = "modified"; return f; } },
    publish_page: { description: "Publish a page; referenced fragments must be published first (or pass includeFragments).", shape: 1,
      schema: z.object({ pageId: z.string(), includeFragments: z.boolean().default(false) }),
      run(a, s) { init(s); const p = s.pages.get(a.pageId); if (!p) throw new Error(`Unknown page '${a.pageId}'`);
        const refs = p.components.filter((c) => c.type === "fragment").map((c) => s.fragments.get(c.props.fragmentId));
        const pending = refs.filter((f) => f.status !== "published");
        if (pending.length && !a.includeFragments) throw new Error(`Unpublished fragments: ${pending.map((f) => f.name).join(", ")}`);
        pending.forEach((f) => (f.status = "published")); p.status = "published"; p.publishedAt = new Date().toISOString(); return { id: p.id, path: p.path, status: p.status, fragmentsPublished: pending.length }; } },
    unpublish_page: { description: "Take a page offline.", shape: 1, schema: z.object({ pageId: z.string() }),
      run(a, s) { init(s); const p = s.pages.get(a.pageId); if (!p) throw new Error(`Unknown page '${a.pageId}'`); p.status = "draft"; return { id: p.id, status: p.status }; } },
    list_pages: { description: "List pages, optionally by path prefix.", shape: 1, schema: z.object({ prefix: z.string().optional() }),
      run: (a, s) => (init(s), [...s.pages.values()].filter((p) => !a.prefix || p.path.startsWith(a.prefix)).map(({ id, path, title, status }) => ({ id, path, title, status }))) },
  },
});
