export function limitModelCalls(call,limit=2){
  const states=new Map();
  return async options=>{
    let state=states.get(options.provider);if(!state){state={active:0,waiting:[]};states.set(options.provider,state);}
    if(state.active<limit)state.active++;else await new Promise(resolve=>state.waiting.push(resolve));
    try{
      if(options.shouldRun&&!options.shouldRun()){const e=new Error('job-cancelled-before-send');e.notSent=true;throw e;}
      return await call(options);
    }finally{const next=state.waiting.shift();if(next)next();else state.active--;}
  };
}
