const { mem, fsSize, dockerInfo, networkStats } = require('systeminformation');
const express = require('express');
const request = require('request');
const { readFileSync, unlinkSync } = require('fs');
const { Database } = require('sqlite3');
const { sign, verify } = require('jsonwebtoken');
var cors = require('cors');
const privateKEY = readFileSync('./private.key', 'utf8');
const publicKEY = readFileSync('./public.key', 'utf8');
const app = express();

var cpuStat = require('cpu-stat');

// SIGNING OPTIONS
const signOptions = {
    issuer: "SPEC",
    subject: "pcid@spec.cl",
    audience: "http://spec.cl/",
    expiresIn: "30m",
    algorithm: "RS256"
};

/*
 ====================   JWT Verify =====================
*/
const verifyOptions = {
    issuer: "SPEC",
    subject: "pcid@spec.cl",
    audience: "http://spec.cl/",
    expiresIn: "30m",
    algorithm: ["RS256"]
};

// setting the enviromental variables
const SQLITE_PATH_FILE = process.env.SQLITE_PATH_FILE;
const PORT = process.env.PORT;
const APIKEY = process.env.APIKEY;
const MAX_RECORDS = process.env.MAX_RECORDS || 100;
const SECONDS_INTERVAL = process.env.SECONDS_INTERVAL || 60;
const SERVER_NAME = process.env.SERVER_NAME || "Unknown server";
const DELETE_SQLITE_FILE_ON_RESTART = process.env.DELETE_SQLITE_FILE_ON_RESTART;
const DATA_DISK_MOUNT_MEASURE = process.env.DATA_DISK_MOUNT_MEASURE;
const DATA_NETWORK_IFACE_MEASURE = process.env.DATA_NETWORK_IFACE_MEASURE;
const APIGATEWAY = process.env.APIGATEWAY;
let defaultMemoryRecords = 10;

const apikey = process.env.APIGATEWAYKEY;
const operation = "putObject";
const key = process.env.BUCKETKEYFILE;
const bucket = process.env.BUCKET;
const expires = parseInt(process.env.URLEXPIRESIN);
const acl = "public-read";
const minutesIntervar = parseInt(process.env.PUTS3MINUTESINTERVAL);

try {
    if (DELETE_SQLITE_FILE_ON_RESTART === 'YES') {
        unlinkSync(SQLITE_PATH_FILE);
    }
} catch (error) { console.log(`File ${SQLITE_PATH_FILE} is already deleted`); }

// api hashmap
const apiKeys = new Map();
apiKeys.set(APIKEY, { id: 1, name: 'Api key USER' });

// middleware for checking the apikey
const apiKeyHandler = (req, res, next) => {
    if (!req.query.apikey && !req.query.token) { res.status(401).send('Forbidden access'); return; }

    if (apiKeys.has(req.query.apikey)) {
        req.authType = "apikey";
        next();
    } else {
        try {
            req.jwtPayload = verify(req.query.token, publicKEY, verifyOptions);
            req.authType = "token";
            next();
        }
        catch (error) {
            res.status(403).send('Unauthorized');
        }
    }

}
app.use(apiKeyHandler);

// enable CORS
app.use(cors());

// setting the sqlite and run the service
const db = new Database(SQLITE_PATH_FILE, async (err) => {
    if (err) {
        console.log('Error when creating the database', err)
    } else {
        console.log('Database created!')
        await createTable();
        try {
            await createTrigger();
        } catch (error) {
            console.log("Error in createTrigger: " + error);
        }

        startRegister();
    }
});

function createTable() {
    return new Promise((res, rej) => {
        db.run(`
        CREATE TABLE IF NOT EXISTS memory(
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            val TEXT
        )    
        `
            , (d, err) => {
                if (err) { rej(err); }
                else { res(d); }
            });
    });
}
function createTrigger() {
    return new Promise((res, rej) => {
        db.run(`    
            CREATE TRIGGER DataSize AFTER INSERT ON memory
            BEGIN
            delete from memory where 
                id =(select min(id) from memory ) and (select count(*) from memory )=${MAX_RECORDS};
            END`,
            (d, err) => {
                if (err) { rej(err); }
                else { res(d); }
            }
        )
    });
}
function startRegister() {
    setInterval(
        async () => {
            let memData;
            let cpuData;
            let diskData;
            let networkData;
            let dockerData;

            try {
                memData = await mem().then(x => ({
                    "memory": {
                        "total": x.total,
                        "free": x.free,
                        "used": x.used,
                        "active": x.active,
                        "available": x.available,
                        "buffcache": x.buffcache
                    },
                    "swap": {
                        "total": x.swaptotal,
                        "used": x.swapused,
                        "free": x.swapfree
                    }
                }));
            }
            catch (error) { }

            try {
                cpuData = await new Promise((res, rej) => {
                    cpuStat.usagePercent({ sampleMs: 2000 }, function (err, percent, seconds) {
                        if (err) { rej(data); }
                        else { res(parseInt(percent)); }
                    });
                });
            } catch (error) { }

            try {
                diskData = await fsSize().then(f => f.find(x => x.mount === DATA_DISK_MOUNT_MEASURE)).then(x => ({ use: x.use, mount: x.mount }));
            } catch (error) { }

            try {
                networkData = await networkStats().then(data => data.find(x => x.iface === DATA_NETWORK_IFACE_MEASURE)).then(x => ({ operstate: x.operstate, iface: x.iface }));
            } catch (error) { }

            try {
                dockerData = await dockerInfo().then(data => ({ containers: data.containers, containersRunning: data.containersRunning }));
            } catch (error) { }
            insertData({ ...memData, cpu: cpuData, disk: diskData, network: networkData, docker: dockerData });

        },
        1000 * SECONDS_INTERVAL);

    queryAllAndPutToS3((s) => console.log(s));

    setInterval(() => {
        queryAllAndPutToS3((s) => console.log(s));
    }, 1000 * 60 * minutesIntervar);
}
const insertData = (info) => {
    const s = JSON.stringify({ date: new Date().toISOString(), ...info });
    try {
        const q = db.prepare(`INSERT INTO memory (val) VALUES (?);`);
        q.run(s);
    } catch (error) { console.log("Error in insertData function"); }

}
function jsonFormat(d) {
    return JSON.parse(d.val);
}

const payload = { server: SERVER_NAME };

app.get('/login', function (req, res) {
    if (req.authType !== 'apikey') { res.send('loggin forbidden'); }
    res.send(sign({ ...payload, from: 'Local server testing ..' }, privateKEY, signOptions));
});
app.get('/is-logged', function (req, res) {
    res.json({ payload: req.jwtPayload, authType: req.authType, hola: "oliasflksajdfl" });
});
app.get('/memory', function (req, res) {
    mem()
        .then(data => {
            cpuStat.usagePercent({ sampleMs: 150 }, function (err, percent, seconds) {
                if (err) { res.json(jsonFormat(data)); }
                else { res.json(jsonFormat({ ...data, cpu: parseInt(percent) })); }
            });
        })
        .catch(error => console.error(error));
});
app.get('/cpu', function (req, res) {
    cpuStat.usagePercent({ sampleMs: 150 }, function (err, percent, seconds) {
        res.send(parseInt(percent));
    });
});
app.get('/memory-history', function (req, res) {

    if (req.query.limit && !isNaN(Number(req.query.limit))) { defaultMemoryRecords = Number(req.query.limit); }

    db.all(`SELECT * FROM memory ORDER BY id DESC LIMIT ${defaultMemoryRecords}`, (err, rows) => {
        if (err) { res.send(err); return; }
        res.json(rows.map(m => jsonFormat(m)));
    });
});
app.listen(PORT, () => {
    console.log(`MemoryApp listening on port ${PORT}!`);
});

function queryAllAndPutToS3(cb) {
    db.all(`SELECT * FROM memory ORDER BY id DESC`, (err, rows) => {
        if (err) { cb(err); return; }
        const data = rows.map(m => jsonFormat(m));
        request.get(APIGATEWAY,
            { headers: { "x-api-key": apikey }, qs: { operation, key, bucket, expires, acl } },
            (err, resp) => request.put(resp.body, { body: JSON.stringify(data), headers: { 'Cache-Control': 'max-age=480' } }, (q, c) => {
                if (q) {
                    cb(q)
                } else {
                    cb(c.statusCode)
                }
            }));
    });
}