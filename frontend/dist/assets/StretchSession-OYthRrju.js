import{b as H,e as P,r,j as e}from"./index-JwZocPeU.js";import{C as R}from"./circle-check-BTAfSlA3.js";const L=[{id:"leg-swings",name:"Leg Swings",duration:30,reps:"10 each side",type:"dynamic",muscle:"hips & hip flexors",cue:"Stand beside a wall, swing leg forward and back in a controlled arc.",videoUrl:"https://www.youtube.com/shorts/Q0HNSqK5f1Q"},{id:"hip-circles",name:"Hip Circles",duration:30,reps:"10 each direction",type:"dynamic",muscle:"hip flexors & glutes",cue:"Hands on hips, draw big circles with your hips. Keep feet planted.",videoUrl:"https://www.youtube.com/shorts/3fAHDCGzAqg"},{id:"high-knees",name:"High Knees",duration:30,reps:"30 seconds",type:"dynamic",muscle:"hip flexors & quads",cue:"Run in place, driving knees to waist height. Pump your arms.",videoUrl:"https://www.youtube.com/shorts/tx3lIiXfMnw"},{id:"butt-kicks",name:"Butt Kicks",duration:30,reps:"30 seconds",type:"dynamic",muscle:"hamstrings & quads",cue:"Run in place, kicking heels up to your glutes. Stay on your toes.",videoUrl:"https://www.youtube.com/shorts/0T_JEqcjOLQ"},{id:"ankle-rolls",name:"Ankle Rolls",duration:30,reps:"10 each direction",type:"dynamic",muscle:"ankles & calves",cue:"Lift one foot, rotate ankle in full circles. Switch feet.",videoUrl:"https://www.youtube.com/shorts/IqRGBQSf8Gk"},{id:"walking-lunges",name:"Walking Lunges",duration:40,reps:"10 each leg",type:"dynamic",muscle:"quads, hip flexors, glutes",cue:"Step forward into a lunge, back knee nearly touching ground. Alternate legs walking forward.",videoUrl:"https://www.youtube.com/shorts/L8fvypPrv5g"}],T=[{id:"standing-quad",name:"Standing Quad Stretch",duration:30,reps:"Hold 30s each side",type:"static",muscle:"quadriceps",cue:"Stand on one leg, pull other foot to glutes. Keep knees together. Use a wall for balance.",videoUrl:"https://www.youtube.com/shorts/example1"},{id:"hamstring-stretch",name:"Hamstring Stretch",duration:30,reps:"Hold 30s each side",type:"static",muscle:"hamstrings",cue:"Sit on ground, extend one leg. Reach toward your toes, keeping back flat.",videoUrl:"https://www.youtube.com/shorts/example2"},{id:"calf-stretch",name:"Calf Stretch",duration:30,reps:"Hold 30s each side",type:"static",muscle:"calves & achilles",cue:"Press hands on wall, one leg back with heel flat on ground. Lean into wall.",videoUrl:"https://www.youtube.com/shorts/example3"},{id:"hip-flexor",name:"Hip Flexor Stretch",duration:30,reps:"Hold 30s each side",type:"static",muscle:"hip flexors",cue:"Kneel on one knee, other foot forward. Push hips forward gently until you feel the stretch.",videoUrl:"https://www.youtube.com/shorts/example4"},{id:"figure-four",name:"Figure Four (Piriformis)",duration:30,reps:"Hold 30s each side",type:"static",muscle:"glutes & piriformis",cue:"Lie on back. Cross ankle over opposite knee. Pull the uncrossed leg toward you.",videoUrl:"https://www.youtube.com/shorts/example5"},{id:"childs-pose",name:"Child's Pose",duration:45,reps:"Hold 45 seconds",type:"static",muscle:"lower back, hips, quads",cue:"Kneel, sit back on heels, reach arms forward on the ground. Breathe deeply.",videoUrl:"https://www.youtube.com/shorts/example6"}];function W({stretchName:u,active:s}){const n=(o=>{const t=o.toLowerCase();return t.includes("hip")||t.includes("lunge")?"hip":t.includes("quad")?"quad":t.includes("hamstring")?"hamstring":t.includes("calf")?"calf":t.includes("shoulder")||t.includes("arm")||t.includes("cross")?"shoulder":t.includes("neck")?"neck":t.includes("glute")||t.includes("pigeon")?"glute":t.includes("back")||t.includes("cat")||t.includes("spine")?"back":t.includes("ankle")||t.includes("roll")?"ankle":"sway"})(u);return e.jsxs(e.Fragment,{children:[e.jsx("style",{children:`
        @keyframes hip-body { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(12deg); transform-origin: 50px 25px; } }
        @keyframes hip-lleg { 0%,100% { transform: translateX(0); } 50% { transform: translateX(-8px); } }
        @keyframes hip-rleg { 0%,100% { transform: translateX(0); } 50% { transform: translateX(8px); } }
        
        @keyframes quad-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-35deg); transform-origin: 50px 75px; } }
        @keyframes quad-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(0deg); } }
        
        @keyframes hamstring-body { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(18deg); transform-origin: 50px 25px; } }
        @keyframes hamstring-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(0deg); } }
        @keyframes hamstring-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(0deg); } }
        
        @keyframes calf-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(15deg); transform-origin: 50px 75px; } }
        @keyframes calf-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-15deg); transform-origin: 50px 75px; } }
        
        @keyframes shoulder-larm { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-40deg); transform-origin: 50px 40px; } }
        @keyframes shoulder-rarm { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-40deg); transform-origin: 50px 40px; } }
        
        @keyframes neck-head { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(15deg); } 75% { transform: rotate(-15deg); } }
        
        @keyframes glute-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(45deg); transform-origin: 50px 75px; } }
        @keyframes glute-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-10deg); transform-origin: 50px 75px; } }
        
        @keyframes back-body { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-15deg); transform-origin: 50px 40px; } }
        
        @keyframes ankle-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(12deg); transform-origin: 30px 115px; } }
        @keyframes ankle-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-12deg); transform-origin: 70px 115px; } }
        
        @keyframes sway-body { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(5deg); transform-origin: 50px 25px; } }
        @keyframes sway-larm { 0%,100% { transform: translateY(0); } 50% { transform: translateY(3px); } }
        @keyframes sway-rarm { 0%,100% { transform: translateY(0); } 50% { transform: translateY(3px); } }
        
        .animate-hip-body { animation: hip-body 2.5s ease-in-out infinite; }
        .animate-hip-lleg { animation: hip-lleg 2.5s ease-in-out infinite; }
        .animate-hip-rleg { animation: hip-rleg 2.5s ease-in-out infinite; }
        
        .animate-quad-lleg { animation: quad-lleg 2.5s ease-in-out infinite; }
        .animate-quad-rleg { animation: quad-rleg 2.5s ease-in-out infinite; }
        
        .animate-hamstring-body { animation: hamstring-body 2.5s ease-in-out infinite; }
        
        .animate-calf-lleg { animation: calf-lleg 2.5s ease-in-out infinite; }
        .animate-calf-rleg { animation: calf-rleg 2.5s ease-in-out infinite; }
        
        .animate-shoulder-larm { animation: shoulder-larm 2.5s ease-in-out infinite; }
        .animate-shoulder-rarm { animation: shoulder-rarm 2.5s ease-in-out infinite; }
        
        .animate-neck-head { animation: neck-head 3s ease-in-out infinite; }
        
        .animate-glute-lleg { animation: glute-lleg 2.5s ease-in-out infinite; }
        .animate-glute-rleg { animation: glute-rleg 2.5s ease-in-out infinite; }
        
        .animate-back-body { animation: back-body 2.5s ease-in-out infinite; }
        
        .animate-ankle-lleg { animation: ankle-lleg 2.5s ease-in-out infinite; }
        .animate-ankle-rleg { animation: ankle-rleg 2.5s ease-in-out infinite; }
        
        .animate-sway-body { animation: sway-body 3s ease-in-out infinite; }
        .animate-sway-larm { animation: sway-larm 3s ease-in-out infinite; }
        .animate-sway-rarm { animation: sway-rarm 3s ease-in-out infinite; }
      `}),e.jsx("div",{style:{width:160,height:200,margin:"0 auto"},children:e.jsxs("svg",{viewBox:"0 0 100 140",style:{width:"100%",height:"100%"},children:[e.jsx("circle",{cx:"50",cy:"15",r:"10",fill:"none",stroke:"#EAB308",strokeWidth:"2.5",className:s&&n==="neck"?"animate-neck-head":""}),e.jsx("line",{x1:"50",y1:"25",x2:"50",y2:"75",stroke:"#6b7280",strokeWidth:"2.5",className:s?`animate-${n}-body`:"",style:{transformOrigin:"50px 25px"}}),e.jsx("line",{x1:"50",y1:"40",x2:"25",y2:"60",stroke:"#6b7280",strokeWidth:"2.5",className:s?`animate-${n}-larm`:"",style:{transformOrigin:"50px 40px"}}),e.jsx("line",{x1:"50",y1:"40",x2:"75",y2:"60",stroke:"#6b7280",strokeWidth:"2.5",className:s?`animate-${n}-rarm`:"",style:{transformOrigin:"50px 40px"}}),e.jsx("line",{x1:"50",y1:"75",x2:"30",y2:"115",stroke:"#6b7280",strokeWidth:"2.5",className:s?`animate-${n}-lleg`:"",style:{transformOrigin:"50px 75px"}}),e.jsx("line",{x1:"50",y1:"75",x2:"70",y2:"115",stroke:"#6b7280",strokeWidth:"2.5",className:s?`animate-${n}-rleg`:"",style:{transformOrigin:"50px 75px"}})]})})]})}function B(){var N;const u=H(),s=P(),w=new URLSearchParams(s.search).get("type"),o=(((N=s.state)==null?void 0:N.type)||w||"pre")!=="post",t=r.useMemo(()=>o?L:T,[o]),[a,y]=r.useState(0),[b,l]=r.useState(t[0].duration),[f,j]=r.useState(!1),[p,c]=r.useState(!1),[S,d]=r.useState(""),[h,g]=r.useState(!1);r.useEffect(()=>{y(0),l(t[0].duration),j(!1),c(!1),d(""),g(!1)},[t]),r.useEffect(()=>{if(f||p||h)return;const i=setInterval(()=>{l(x=>{if(x<=1){if(clearInterval(i),a>=t.length-1)return g(!0),0;const v=t[a+1];return d(v.name),c(!0),setTimeout(()=>{y(U=>U+1),l(v.duration),c(!1),d("")},2e3),0}return x-1})},1e3);return()=>clearInterval(i)},[f,p,h,a,t]);const m=t[a],k=t[a+1],q=Math.round(a/t.length*100),C=()=>{if(a>=t.length-1){g(!0),l(0);return}const i=t[a+1];d(i.name),c(!0),l(0),setTimeout(()=>{y(x=>x+1),l(i.duration),c(!1),d("")},2e3)};return e.jsxs(e.Fragment,{children:[e.jsx("style",{children:`
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes fadeOut {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(0.95); }
        }
        @keyframes timerPulse {
          0%,100% { color: #EAB308; transform: scale(1); }
          50% { color: #fbbf24; transform: scale(1.15); }
        }
        @keyframes popIn {
          from { transform: scale(0); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .animate-transition-in { animation: fadeIn 0.3s ease forwards; }
        .animate-transition-out { animation: fadeOut 0.3s ease forwards; }
        .animate-timer-pulse { animation: timerPulse 0.6s ease-in-out infinite; }
        .animate-pop-in { animation: popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
      `}),e.jsx("div",{className:"bg-[#0f1117] min-h-screen text-white rounded-2xl",children:e.jsxs("div",{className:"mx-auto flex min-h-screen max-w-[480px] flex-col p-4",children:[e.jsx("div",{className:"mb-4 h-2 w-full rounded-full bg-[#1f2433]",children:e.jsx("div",{className:"h-2 rounded-full bg-yellow-500 transition-all",style:{width:`${h?100:q}%`}})}),e.jsxs("header",{className:"mb-6 flex items-center justify-between",children:[e.jsx("button",{onClick:()=>u(-1),className:"text-slate-300",children:"← Back"}),e.jsxs("div",{className:"text-center",children:[e.jsx("h1",{className:"text-lg font-bold",children:o?"Pre-Run Warmup":"Post-Run Recovery"}),e.jsxs("p",{className:"text-xs text-slate-400",children:[Math.min(a+1,t.length)," / ",t.length]})]}),e.jsx("div",{className:"w-12"})]}),p?e.jsxs("div",{className:"my-auto rounded-2xl border border-[#2a2d3e] bg-[#151823] p-8 text-center animate-transition-in",children:[e.jsx("p",{className:"text-sm text-slate-400",children:"Next up:"}),e.jsx("p",{className:"mt-2 text-2xl font-black text-yellow-500",children:S})]}):h?e.jsxs("div",{className:"my-auto rounded-2xl border border-emerald-600 bg-[#151823] p-8 text-center animate-pop-in",children:[e.jsx("div",{className:"flex justify-center mb-4",children:e.jsx(R,{size:64,color:"#EAB308",strokeWidth:1.5})}),e.jsx("p",{className:"text-3xl font-black text-yellow-500",children:"Session Complete"}),e.jsx("p",{className:"mt-3 text-sm text-slate-300",children:o?"You are warmed up with dynamic movement only. Ready to run strong.":"Recovery complete. Hold static stretches after each run to reduce tightness."}),e.jsx("button",{onClick:()=>u("/log-run"),className:"mt-5 rounded-xl bg-yellow-500 px-5 py-3 font-bold text-black",children:"Done"})]}):e.jsxs(e.Fragment,{children:[e.jsxs("div",{className:`rounded-2xl border border-[#2a2d3e] bg-[#151823] p-5 ${p?"animate-transition-out":"animate-transition-in"}`,children:[e.jsx("span",{className:"rounded-full bg-slate-700 px-2 py-1 text-xs text-slate-200",children:m.muscle}),e.jsx("h2",{className:"mt-3 text-3xl font-black text-white",children:m.name}),e.jsx("p",{className:"mt-3 text-sm text-slate-400",children:m.cue}),e.jsx("p",{className:"mt-3 text-sm font-semibold text-slate-300",children:m.reps}),e.jsx("button",{onClick:()=>window.open(m.videoUrl,"_blank","noopener,noreferrer"),className:"mt-4 border border-[#2a2d3e] text-slate-300 rounded-lg px-4 py-2 text-sm flex items-center gap-2",children:"▶ Watch How"})]}),e.jsxs("div",{className:"my-8 flex flex-col items-center",children:[e.jsx(W,{stretchName:m.name,active:!f}),e.jsx("p",{className:`text-7xl font-black mt-6 ${b<=5?"animate-timer-pulse":"text-yellow-500"}`,children:b}),e.jsxs("div",{className:"mt-3 flex items-center justify-center gap-4",children:[e.jsx("button",{onClick:()=>j(i=>!i),className:"rounded-lg border border-[#2a2d3e] px-3 py-1 text-xs text-slate-300",children:f?"Resume":"Pause"}),e.jsx("button",{onClick:C,className:"text-xs text-slate-400 underline",children:"Skip"})]})]}),e.jsx("footer",{className:"mt-auto pb-4 text-center",children:a===t.length-1?e.jsx("button",{onClick:()=>g(!0),className:"rounded-xl bg-emerald-500 px-5 py-3 font-bold text-black",children:"Done"}):e.jsxs("p",{className:"text-sm text-slate-400",children:["Up next: ",k==null?void 0:k.name," →"]})})]})]})})]})}export{B as default};
