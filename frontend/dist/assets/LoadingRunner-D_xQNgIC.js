import{r as i,j as r}from"./index-xcBp2yTO.js";function o({message:a="Loading..."}){const[s,n]=i.useState("");return i.useEffect(()=>{const t=setInterval(()=>n(e=>e.length>=3?"":e+"."),400);return()=>clearInterval(t)},[]),r.jsxs("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:220,gap:16},children:[r.jsx("style",{children:`
        @keyframes body-bob {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-4px); }
        }
        @keyframes arm-forward {
          0%, 100% { transform: rotate(-40deg); }
          50% { transform: rotate(40deg); }
        }
        @keyframes arm-back {
          0%, 100% { transform: rotate(40deg); }
          50% { transform: rotate(-40deg); }
        }
        @keyframes leg-forward {
          0%, 100% { transform: rotate(-45deg); }
          50% { transform: rotate(45deg); }
        }
        @keyframes leg-back {
          0%, 100% { transform: rotate(45deg); }
          50% { transform: rotate(-45deg); }
        }
        @keyframes calf-forward {
          0%, 100% { transform: rotate(10deg); }
          50% { transform: rotate(-30deg); }
        }
        @keyframes calf-back {
          0%, 100% { transform: rotate(-10deg); }
          50% { transform: rotate(30deg); }
        }
        @keyframes shadow-pulse {
          0%, 100% { transform: scaleX(1); opacity: 0.25; }
          50% { transform: scaleX(0.7); opacity: 0.1; }
        }
        @keyframes track-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-40px); }
        }
        .runner-body { animation: body-bob 0.5s ease-in-out infinite; }
        .arm-l { transform-origin: 2px 2px; animation: arm-forward 0.5s ease-in-out infinite; }
        .arm-r { transform-origin: 2px 2px; animation: arm-back 0.5s ease-in-out infinite; }
        .thigh-l { transform-origin: 2px 2px; animation: leg-forward 0.5s ease-in-out infinite; }
        .thigh-r { transform-origin: 2px 2px; animation: leg-back 0.5s ease-in-out infinite; }
        .calf-l { transform-origin: 2px 2px; animation: calf-forward 0.5s ease-in-out infinite; }
        .calf-r { transform-origin: 2px 2px; animation: calf-back 0.5s ease-in-out infinite; }
        .runner-shadow { transform-origin: center; animation: shadow-pulse 0.5s ease-in-out infinite; }
        .track-line { animation: track-scroll 0.4s linear infinite; }
      `}),r.jsxs("svg",{width:"140",height:"130",viewBox:"0 0 140 130",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:[r.jsx("ellipse",{className:"runner-shadow",cx:"70",cy:"115",rx:"28",ry:"5",fill:"#EAB308"}),r.jsx("g",{clipPath:"url(#track-clip)",children:r.jsx("g",{className:"track-line",children:[0,20,40,60,80,100,120,140,160].map(t=>r.jsx("rect",{x:t,y:"119",width:"12",height:"3",rx:"1.5",fill:"#EAB308",opacity:"0.3"},t))})}),r.jsx("defs",{children:r.jsx("clipPath",{id:"track-clip",children:r.jsx("rect",{x:"10",y:"116",width:"120",height:"8"})})}),r.jsxs("g",{className:"runner-body",style:{transformOrigin:"70px 55px"},children:[r.jsx("circle",{cx:"70",cy:"30",r:"10",fill:"#EAB308"}),r.jsx("rect",{x:"62",y:"26",width:"14",height:"4",rx:"2",fill:"#000"}),r.jsx("rect",{x:"65",y:"40",width:"10",height:"22",rx:"4",fill:"#EAB308"}),r.jsxs("g",{className:"arm-l",style:{transformOrigin:"67px 43px"},children:[r.jsx("rect",{x:"55",y:"43",width:"12",height:"4",rx:"2",fill:"#EAB308"}),r.jsx("rect",{x:"46",y:"39",width:"10",height:"4",rx:"2",fill:"#EAB308"})]}),r.jsxs("g",{className:"arm-r",style:{transformOrigin:"73px 43px"},children:[r.jsx("rect",{x:"73",y:"43",width:"12",height:"4",rx:"2",fill:"#EAB308"}),r.jsx("rect",{x:"84",y:"39",width:"10",height:"4",rx:"2",fill:"#EAB308"})]}),r.jsxs("g",{className:"thigh-l",style:{transformOrigin:"68px 62px"},children:[r.jsx("rect",{x:"64",y:"62",width:"5",height:"16",rx:"2.5",fill:"#EAB308"}),r.jsxs("g",{className:"calf-l",style:{transformOrigin:"66px 78px"},children:[r.jsx("rect",{x:"63",y:"78",width:"5",height:"14",rx:"2.5",fill:"#EAB308"}),r.jsx("rect",{x:"60",y:"90",width:"10",height:"4",rx:"2",fill:"#000"})]})]}),r.jsxs("g",{className:"thigh-r",style:{transformOrigin:"72px 62px"},children:[r.jsx("rect",{x:"71",y:"62",width:"5",height:"16",rx:"2.5",fill:"#EAB308"}),r.jsxs("g",{className:"calf-r",style:{transformOrigin:"73px 78px"},children:[r.jsx("rect",{x:"71",y:"78",width:"5",height:"14",rx:"2.5",fill:"#EAB308"}),r.jsx("rect",{x:"70",y:"90",width:"10",height:"4",rx:"2",fill:"#000"})]})]})]})]}),r.jsxs("p",{style:{fontSize:13,fontWeight:600,color:"var(--text-muted)",letterSpacing:1,textTransform:"uppercase",minWidth:100,textAlign:"center"},children:[a,s]})]})}export{o as L};
