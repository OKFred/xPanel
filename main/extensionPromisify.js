async function read(key, area){
    if(!area) area='local';
    return new Promise((resolve, reject)=>{
        try{
            chrome.storage[area].get(key, (result)=>{
                return resolve(!!Object.keys(result).length?result:false);
            });
        }catch(error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
};

async function write(obj, area){
    if(!area) area='local';
    if (!obj || typeof(obj)!=='object') return false;
    return new Promise((resolve, reject)=>{
        try{
            chrome.storage[area].set(obj, async()=>{
                return resolve(true);
            });
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
};

async function remove(key, area){
    if(!area) area='local';
    return new Promise((resolve, reject)=>{
        try{
            chrome.storage[area].remove(key, async()=>{
                return resolve(true);
            });
        }catch(error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
};

async function clear(area){
    if(!area) area='local';
    return new Promise((resolve, reject)=>{
        try{
            chrome.storage[area].clear(async()=>{
                return resolve(true);
            });
        }catch(error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
};

async function cookie(type, obj){
    if (type==='check') return new Promise((resolve, reject)=>{
        try{
            chrome.cookies.getAll(obj, (cookieArr)=>{
                return resolve(cookieArr);
            });
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
    else if (type==='create') return new Promise((resolve, reject)=>{
        try{
            chrome.cookies.set(obj, (cookieObj)=>{
                return resolve(cookieObj);
            })
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
    else if (type==='clear') return new Promise((resolve, reject)=>{
        try{
            chrome.cookies.remove(obj, (cookieObj)=>{
                return resolve(cookieObj);
            })
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
};

async function alarm(type, alarmName, when){
    if (type==='check') return new Promise((resolve, reject)=>{
        try{
            chrome.alarms.getAll(alarmName, (alarmObj)=>{
                return resolve (alarmObj);
            });
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
    else if (type==='create') return new Promise((resolve, reject)=>{
        try{
            if (!when) return console.trace(alarmName);
            let newAlarm=chrome.alarms.create(alarmName, {when});
            if (!newAlarm) chrome.alarms.get(alarmName, (alarmObj)=>{
                return resolve (alarmObj);
            });
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
    else if (type==='clear') return new Promise((resolve, reject)=>{
        try{
            chrome.alarms.clear(alarmName, (done)=>{
                return resolve (done);
            });
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
};

async function note(type, noteId, noteObj){
    if (type==='check') return new Promise((resolve, reject)=>{
        try{
            chrome.notifications.getPermissionLevel((p)=>{
                return resolve(p);
            });
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
    else if (type==='create') return new Promise((resolve, reject)=>{
        try{
            chrome.notifications.create(noteId, noteObj, (id)=>{
                return resolve (id);
            });
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
    else if (type==='clear') return new Promise((resolve, reject)=>{
        try{
            chrome.notifications.clear(noteId, (id)=>{
                return resolve (id);
            });
        }catch (error){
            console.log(error);
            return reject(null);
        };
    }).catch((e)=>{return false});
};