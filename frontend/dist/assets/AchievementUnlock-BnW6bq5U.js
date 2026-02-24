import{d as n,r as i,j as e}from"./index-BaOvKJ5T.js";/**
 * @license lucide-react v0.474.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const c=[["path",{d:"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z",key:"3c2336"}],["path",{d:"m9 12 2 2 4-4",key:"dzmm74"}]],a=n("BadgeCheck",c);function d({badge:r,onDismiss:t}){return i.useEffect(()=>{const o=setTimeout(t,4e3);return()=>clearTimeout(o)},[t]),e.jsxs("div",{onClick:t,style:{position:"fixed",inset:0,zIndex:100,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center"},children:[e.jsx("style",{children:`
        @keyframes popIn {
          from { transform: scale(0.5); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}),e.jsxs("div",{onClick:o=>o.stopPropagation(),style:{background:"var(--bg-card)",border:"2px solid #EAB308",borderRadius:24,padding:32,maxWidth:300,width:"90%",textAlign:"center",animation:"popIn 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards",boxShadow:"0 0 40px rgba(234,179,8,0.3)"},children:[e.jsx(a,{size:56,color:"#EAB308",style:{margin:"0 auto 16px"}}),e.jsx("p",{style:{fontSize:11,fontWeight:700,color:"#EAB308",letterSpacing:2,textTransform:"uppercase",margin:"0 0 8px"},children:"Achievement Unlocked"}),e.jsx("p",{style:{fontSize:22,fontWeight:900,color:"var(--text-primary)",margin:"0 0 8px"},children:r.name}),r.description&&e.jsx("p",{style:{fontSize:13,color:"var(--text-muted)",margin:"0 0 20px",lineHeight:1.5},children:r.description}),e.jsx("button",{onClick:t,style:{background:"#EAB308",color:"#000",border:"none",borderRadius:12,padding:"10px 28px",fontSize:14,fontWeight:700,cursor:"pointer"},children:"Awesome"})]})]})}export{d as A};
