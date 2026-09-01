"use strict";
console.log("dev panel here")
var welcome=document.getElementById("welcome");	/* 欢迎语 */
var selectMethod=document.getElementById("selectMethod");	/* 请求方式 */
var selectDataType=document.getElementById("selectDataType");	/* 数据类型 */
var btnSend=document.getElementById("btnSend");	/* 表单提交按钮 */
var switchAutoClear=document.getElementById("switchAutoClear");	/* 自动清空 */
var switchRedirect=document.getElementById("switchRedirect");	/* 自动重定向 */
var switchCookies=document.getElementById("switchCookies");	/* Cookies */
var labelCookies=document.getElementById("labelCookies");	/* Cookies */
var labelRedirect=document.getElementById("labelRedirect");	/* 自动重定向 */
var labelAutoClear=document.getElementById("labelAutoClear");	/* 自动清空 */
var inputURL=document.getElementById("inputURL");	/* URL地址 */
var textHeaders=document.getElementById("textHeaders");	/* 数据头 */
var textBody=document.getElementById("textBody");	/* 对象 */
var queryInfo=document.getElementById("queryInfo");	/* 提示信息 */
var requestResult=document.getElementById("requestResult");	/* 返回结果 */

textHeaders.addEventListener('input', resizeRow);
textBody.addEventListener('input', resizeRow);

function loading() {
	welcome.innerText = chrome.i18n.getMessage("welcome");
	btnSend.innerText = chrome.i18n.getMessage("send");
	labelCookies.innerText = chrome.i18n.getMessage("cookies");
	labelRedirect.innerText = chrome.i18n.getMessage("redirect");
	labelAutoClear.innerText = chrome.i18n.getMessage("autoClear");
	queryInfo.innerText = chrome.i18n.getMessage("result");
	inputURL.setAttribute("placeholder", chrome.i18n.getMessage("url"));
	textHeaders.setAttribute("placeholder", chrome.i18n.getMessage("headers"));
	textBody.setAttribute("placeholder", chrome.i18n.getMessage("payload"));
	requestResult.setAttribute("placeholder", chrome.i18n.getMessage("requestResult"));
};
setTimeout(loading, 0);

function resizeRow(){	/* 调整行高 */
	let str =this.value;
	let rowsNeeded=3;
	if(str.match(/\n/g)!=null){
		rowsNeeded=str.match(/\n/g).length+2;
		str=str.replace(/\n,''/g);
	};
	this.rows = rowsNeeded;
};

selectMethod.addEventListener('change',()=>{
	if (selectMethod.value=='GET'){
		selectDataType.selectedOptions[0].innerText = chrome.i18n.getMessage("plainText");
		selectDataType.setAttribute('disabled','');
	}else{
		selectDataType.selectedOptions[0].innerText=selectDataType.selectedOptions[0].value;
		selectDataType.removeAttribute('disabled');
	};
});
btnSend.addEventListener('click', validation);

async function validation(){
	queryResult(false, chrome.i18n.getMessage("checking"));
	requestResult.innerHTML='';
	let method=selectMethod.value;
	let type=selectDataType.value;
	let url=inputURL.value.trim();
	let headers=textHeaders.value.trim().replace(/\n/g,'');
	let body=textBody.value.trim().replace(/\n/g,'');
	let credentials=switchCookies.checked;
	if (!url) return queryResult(false, chrome.i18n.getMessage("urlMissing"));	/* 必填参数 */
	if (!/^http/gi.test(url)) url='http://'+url;
	inputURL.value=url;
	let queryObj={
		"request": {
			"header":{method},
			"url": url,
			"data":"",
		},
		"response": {"data": {}},
		"info": {"type": "dev"}
	};
	if (body){
		try{
			queryObj.request.data=JSON.parse(body);
			textBody.value=JSON.stringify(queryObj.request.data, null, '\t');
		}catch(e){
			return queryResult(false, chrome.i18n.getMessage("bodyMalformed"));
		};
	};
	if (!credentials) queryObj.request.header.credentials='omit'; 
	if (method=='POST') queryObj.request.header["Content-Type"]=type;
	(switchRedirect.checked)?delete queryObj.request.header["redirect"] :queryObj.request.header["redirect"]='manual';
	if (headers!=''){	/* 额外 headers */
		try{
			queryObj.request.header.headers=JSON.parse(headers);
			textHeaders.value=JSON.stringify(queryObj.request.header.headers, null, '\t')
		}catch(e){
			return queryResult(false, chrome.i18n.getMessage("headerMalformed"));
		};
	};
	let res;
	try{res=await doFetch(queryObj)}catch(e){
		return queryResult(false, chrome.i18n.getMessage("networkError")+' '+e.message);
	}
	let dataLog;
	let data=res.response.data;
	let {redirected,status,ok}=res.response.net;
	let result=typeof(data)=='object'?JSON.stringify(data):data;
	requestResult.innerText=result;
	queryResult(ok, `${chrome.i18n.getMessage("redirect")}: ${redirected}; \n${chrome.i18n.getMessage("status")}: ${status}; \n${chrome.i18n.getMessage("length")}: ${result.length}`);
	dataLog=(typeof(data)=='object')? "console.log("+JSON.stringify(data)+")":"console.log(`"+data+"`)";
	let code=(switchAutoClear.checked)? "console.clear();"+dataLog: "console.log('%c'+'++++++++++++++++++++', 'color: red');"+dataLog;
	chrome.devtools.inspectedWindow.eval(code, (result, isException)=>{
		if (isException) return console.log('Exception: '+result);
		return console.log('Execution: '+result);
	});
	return;
};

function queryResult(ok, info){
	let ele=queryInfo;
	if (typeof(info)=='undefined'){
		info='query success!';
	}else if (typeof(info)=='object'){
		info=JSON.stringify(info);
	};
	ele.innerText=info;
	(!ok)? ele.style.color='orangered' : ele.style.color='seagreen';
};