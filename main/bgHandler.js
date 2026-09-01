function handleRequestHeaders(){
	return [
		async (details) => {
        	if (!/localhost|127.0.0.1/gi.test(details.initiator)) return;
			let { requestHeaders, url } = details;
			let origin = new URL(url).origin;
			let newRequestHeaders = requestHeaders.filter((obj) => !/origin|referer|referrer/gi.test(obj.name));
			if (requestHeaders.length===newRequestHeaders.length) return;
			newRequestHeaders.push({"name":"origin","value":origin},{"name":"referer","value":origin});
			return { requestHeaders: newRequestHeaders };
		},
		{urls: ["<all_urls>"]},
		["blocking", "requestHeaders", "extraHeaders"]
	]
};   //in case some servers check the origin/referer

function handleResponseHeaders(){
    return [
		(details)=>{
			if (!/localhost|127.0.0.1/gi.test(details.initiator)) return;
            let {responseHeaders}=details;
			let newResponseHeaders=responseHeaders.filter((headerObj)=>(!/access-control-allow-origin/gi.test(headerObj.name)));
			newResponseHeaders.push({name:"access-control-allow-origin",value:"*"});
			return { responseHeaders: newResponseHeaders };
		},
		{urls: ["<all_urls>"]},
		["blocking", "responseHeaders", "extraHeaders"]
    ]
}   //handle CORS requests when dev