import { z } from "zod";
import { Agent, uid, coll } from "./base.js";

const init = (s) => { coll(s, "assets"); s.folders ??= new Set(["/content/dam"]); };
const RENDITIONS = { image: ["thumbnail.140.100", "web.1280.1280", "original"], video: ["poster", "original"], document: ["thumbnail.140.100", "original"] };
const kind = (n) => (/\.(png|jpe?g|gif|webp|svg)$/i.test(n) ? "image" : /\.(mp4|mov|webm)$/i.test(n) ? "video" : "document");

export const aemAssets = new Agent({
  key: "aem_assets", name: "AEM Assets Agent", product: "Adobe Experience Manager Assets",
  description: "Asset discovery, metadata, folders, renditions and asset workflows.",
  keywords: ["aem assets", "asset", "dam", "metadata", "folder", "rendition", "tag", "image", "video", "brand portal"],
  tools: {
    create_folder: { description: "Create a DAM folder (parent must exist).", shape: 1, schema: z.object({ path: z.string().regex(/^\/content\/dam\/[\w\-/]+$/) }),
      run(a, s) { init(s); const parent = a.path.slice(0, a.path.lastIndexOf("/")); if (!s.folders.has(parent)) throw new Error(`Parent folder ${parent} does not exist`);
        s.folders.add(a.path); return { path: a.path }; } },
    upload_asset: { description: "Upload an asset to a folder; renditions are generated and a processing workflow starts.", shape: 1,
      schema: z.object({ folder: z.string(), filename: z.string(), sizeBytes: z.number().int().positive(), metadata: z.record(z.string()).default({}), tags: z.array(z.string()).default([]) }),
      run(a, s) { init(s); if (!s.folders.has(a.folder)) throw new Error(`Unknown folder ${a.folder}`);
        const path = `${a.folder}/${a.filename}`; if ([...s.assets.values()].some((x) => x.path === path)) throw new Error(`Asset exists at ${path}`);
        const v = { id: uid("ast"), path, type: kind(a.filename), sizeBytes: a.sizeBytes, metadata: { "dc:title": a.filename, ...a.metadata }, tags: a.tags, renditions: RENDITIONS[kind(a.filename)], status: "processed", workflows: ["dam-update-asset"] };
        s.assets.set(v.id, v); return v; } },
    update_metadata: { description: "Merge metadata and/or add tags on an asset.", shape: 1,
      schema: z.object({ assetId: z.string(), metadata: z.record(z.string()).default({}), addTags: z.array(z.string()).default([]) }),
      run(a, s) { init(s); const x = s.assets.get(a.assetId); if (!x) throw new Error(`Unknown asset '${a.assetId}'`);
        Object.assign(x.metadata, a.metadata); x.tags = [...new Set([...x.tags, ...a.addTags])]; return x; } },
    search_assets: { description: "Discover assets by text, folder, type, tag, or metadata equality.", shape: 1,
      schema: z.object({ text: z.string().optional(), folder: z.string().optional(), type: z.enum(["image", "video", "document"]).optional(), tag: z.string().optional(), metadata: z.record(z.string()).optional() }),
      run: (a, s) => (init(s), [...s.assets.values()].filter((x) =>
        (!a.folder || x.path.startsWith(a.folder + "/")) && (!a.type || x.type === a.type) && (!a.tag || x.tags.includes(a.tag)) &&
        (!a.text || JSON.stringify([x.path, x.metadata, x.tags]).toLowerCase().includes(a.text.toLowerCase())) &&
        Object.entries(a.metadata ?? {}).every(([k, v]) => x.metadata[k] === v)).map(({ id, path, type, tags }) => ({ id, path, type, tags }))) },
    list_renditions: { description: "List renditions of an asset.", shape: 1, schema: z.object({ assetId: z.string() }),
      run(a, s) { init(s); const x = s.assets.get(a.assetId); if (!x) throw new Error(`Unknown asset '${a.assetId}'`); return { path: x.path, renditions: x.renditions }; } },
    move_asset: { description: "Move an asset to another folder.", shape: 1, schema: z.object({ assetId: z.string(), toFolder: z.string() }),
      run(a, s) { init(s); const x = s.assets.get(a.assetId); if (!x) throw new Error(`Unknown asset '${a.assetId}'`); if (!s.folders.has(a.toFolder)) throw new Error(`Unknown folder ${a.toFolder}`);
        x.path = `${a.toFolder}/${x.path.split("/").pop()}`; return x; } },
    run_asset_workflow: { description: "Run a workflow on an asset: reprocess (regenerate renditions), approve, or archive.", shape: 1,
      schema: z.object({ assetId: z.string(), workflow: z.enum(["reprocess", "approve", "archive"]) }),
      run(a, s) { init(s); const x = s.assets.get(a.assetId); if (!x) throw new Error(`Unknown asset '${a.assetId}'`);
        if (a.workflow === "reprocess") x.renditions = RENDITIONS[x.type]; else x.status = a.workflow === "approve" ? "approved" : "archived";
        x.workflows.push(a.workflow); return { id: x.id, status: x.status, workflows: x.workflows }; } },
    get_asset: { description: "Get an asset by id.", shape: 1, schema: z.object({ assetId: z.string() }),
      run(a, s) { init(s); const x = s.assets.get(a.assetId); if (!x) throw new Error(`Unknown asset '${a.assetId}'`); return x; } },
  },
});
