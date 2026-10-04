import assert from "node:assert/strict";
import test from "node:test";
import { scrollDocument } from "../../dist/ui/document-scroll.js";

function state(ports, offsets = []) {
  return { scrollOffsets: offsets, scrollAnchor: {source:null,rowOffset:0}, documentState:{focus:null},
    rendering:{pendingReveal:null,pendingFocus:null,summary:{documentRowCount:100,scrollAnchors:[],focusOrder:[]},
      viewport:{focusTargets:[],scrollPorts:ports,cellInline:512,cellBlock:1024,viewportOverflow:{x:"auto",y:"auto"}}} };
}
const port=(node,parent,maxBlock,userScrollBlock=true)=>({node,parent,inline:0,block:0,minInline:0,maxInline:0,minBlock:0,maxBlock,userScrollInline:false,userScrollBlock});

test("nested wheel deltas chain unconsumed movement and use controlled offsets before frame acceptance",()=>{
  const initial=state([port("outer",null,4096),port("inner","outer",2048)]);
  const first=scrollDocument(initial,3,0,10,"inner");
  assert.equal(first.scrollOffsets.find(value=>value.node==="inner").block,2048);
  assert.equal(first.scrollOffsets.find(value=>value.node==="outer").block,1024);
  const second=scrollDocument(first,5,0,10,"inner");
  assert.equal(second.scrollOffsets.find(value=>value.node==="outer").block,4096);
  assert.equal(second.scrollAnchor.rowOffset,2);
  const back=scrollDocument(second,-1,0,10,"inner");
  assert.equal(back.scrollOffsets.find(value=>value.node==="inner").block,1024);
});

test("hidden ports do not consume user scrolling and root hidden prevents fallback",()=>{
  const initial=state([port("outer",null,4096),port("hidden","outer",2048,false)]);
  const moved=scrollDocument(initial,2,0,10,"hidden");
  assert.equal(moved.scrollOffsets.find(value=>value.node==="hidden"),undefined);
  assert.equal(moved.scrollOffsets.find(value=>value.node==="outer").block,2048);
  const blocked={...initial,rendering:{...initial.rendering,viewport:{...initial.rendering.viewport,viewportOverflow:{x:"hidden",y:"hidden"}}}};
  assert.equal(scrollDocument(blocked,10,0,10,"outer").scrollAnchor.rowOffset,0);
});

test("RTL inline offsets consume negative movement and clamp at both boundaries",()=>{
  const rtl={...port("rtl",null,0),minInline:-2048,maxInline:0,userScrollInline:true};
  const left=scrollDocument(state([rtl]),0,-3,10,"rtl");
  assert.equal(left.scrollOffsets[0].inline,-1536);
  const edge=scrollDocument(left,0,-3,10,"rtl");
  assert.equal(edge.scrollOffsets[0].inline,-2048);
  assert.equal(scrollDocument(edge,0,20,10,"rtl").scrollOffsets[0].inline,0);
});

test("root inline scrolling chains nested remainders and honors both root overflow policies",()=>{
  const initial=state([{...port("inner",null,0),maxInline:1024,userScrollInline:true}]);
  initial.rendering.viewport.minScrollColumn=0;
  initial.rendering.viewport.maxScrollColumn=20;
  const first=scrollDocument(initial,0,5,10,"inner");
  assert.equal(first.scrollOffsets[0].inline,1024);
  assert.equal(first.scrollColumn,3);
  assert.equal(scrollDocument(first,0,40,10).scrollColumn,20);
  const reverse=scrollDocument(first,0,-20,10,"inner");
  assert.equal(reverse.scrollOffsets[0].inline,0);
  assert.equal(reverse.scrollColumn,0);
  for(const overflow of ["hidden","clip"]){
    const blocked={...first,rendering:{...first.rendering,viewport:{...first.rendering.viewport,viewportOverflow:{x:overflow,y:"auto"}}}};
    assert.equal(scrollDocument(blocked,2,5,10).scrollColumn,3);
    assert.equal(scrollDocument(blocked,2,5,10).scrollAnchor.rowOffset,2);
  }
});

test("root RTL scrolling retains negative controlled offsets before frame acceptance",()=>{
  const initial=state([]);
  initial.rendering.viewport.minScrollColumn=-20;
  initial.rendering.viewport.maxScrollColumn=0;
  const first=scrollDocument(initial,0,-7,10);
  assert.equal(first.scrollColumn,-7);
  assert.equal(scrollDocument(first,0,-40,10).scrollColumn,-20);
  assert.equal(scrollDocument(first,0,40,10).scrollColumn,0);
});

test("root pointer scrolling does not route through an unrelated focused nested owner",()=>{
  const initial=state([{...port("nested",null,4096),maxInline:4096,userScrollInline:true}]);
  initial.documentState.focus="nested";
  initial.rendering.viewport.maxScrollColumn=20;
  const moved=scrollDocument(initial,2,3,10,null);
  assert.equal(moved.scrollColumn,3);
  assert.equal(moved.scrollAnchor.rowOffset,2);
  assert.deepEqual(moved.scrollOffsets,[]);
});
