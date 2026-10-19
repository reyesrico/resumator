import { describe,it,expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { makeDocx } from "./fixtures";
import { inspectBrowserWord,renderBrowserWord } from "../src/browser/word";
function bytes(buffer:Uint8Array){return buffer.slice().buffer as ArrayBuffer;}
describe("browser-only Word editing",()=>{
  it("preserves unchanged style runs and unrelated archive contents",()=>{
    const source=bytes(makeDocx('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Built </w:t></w:r><w:r><w:t>reliable web applications.</w:t></w:r></w:p>'));
    const result=renderBrowserWord(source,[{id:"p0",text:"Built robust web applications.",reason:"Role language"}]);
    expect(inspectBrowserWord(result)[0].text).toBe("Built robust web applications.");
    const original=unzipSync(new Uint8Array(source)),edited=unzipSync(new Uint8Array(result));
    expect(strFromU8(edited["word/document.xml"])).toContain("<w:b/>");
    for(const name of Object.keys(original))if(name!=="word/document.xml")expect(edited[name]).toEqual(original[name]);
  });
  it("blocks fact downgrades and linked paragraphs",()=>{
    const source=bytes(makeDocx('<w:p><w:r><w:t>Engineer with 10+ years of experience.</w:t></w:r></w:p><w:p><w:hyperlink><w:r><w:t>Profile</w:t></w:r></w:hyperlink></w:p>'));
    expect(()=>renderBrowserWord(source,[{id:"p0",text:"Engineer with 5+ years of experience.",reason:"Job requirement"}])).toThrow("Numbers");
    expect(inspectBrowserWord(source)[1].editable).toBe(false);
    expect(()=>renderBrowserWord(source,[{id:"p1",text:"Other profile",reason:"Change"}])).toThrow("protected");
    expect(renderBrowserWord(source,[])).toBe(source);
  });
});
