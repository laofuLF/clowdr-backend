"use strict";
require('dotenv').config()

const Parse = require("parse/node");
const express = require('express');
const bodyParser = require('body-parser');
const moment = require("moment");
const {createEventAdapter} = require('@slack/events-api');
const {createMessageAdapter} = require('@slack/interactive-messages');
const {WebClient} = require('@slack/web-api');
var jwt = require('jsonwebtoken');
const crypto = require('crypto');


const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET);
const slackInteractions = createMessageAdapter(process.env.SLACK_SIGNING_SECRET);

const {videoToken, ChatGrant, AccessToken} = require('./tokens');
const axios = require('axios');
const qs = require('qs');

var cors = require('cors')

const Twilio = require("twilio");


Parse.initialize(process.env.REACT_APP_PARSE_APP_ID, process.env.REACT_APP_PARSE_JS_KEY, process.env.PARSE_MASTER_KEY);
Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;


const masterTwilioClient = Twilio(process.env.TWILIO_MASTER_SID, process.env.TWILIO_MASTER_AUTH_TOKEN);


const app = express();
app.use(cors())
app.use('/slack/events', slackEvents.expressMiddleware());

app.use('/slack/interaction', slackInteractions.expressMiddleware());
app.post('/slack/commands', bodyParser.urlencoded({extended: false}), slackSlashCommand);
const sidToRoom = {};
const confCache = {};
const userToAuthData = {};
const userToWorkspaces = {};

let SlackHomeBlocks = Parse.Object.extend("SlackHomeBlocks");
let ClowdrInstance = Parse.Object.extend("ClowdrInstance");
let ClowdrInstanceAccess = Parse.Object.extend("ClowdrInstanceAccess");

let InstanceConfig = Parse.Object.extend("InstanceConfiguration");
let BreakoutRoom = Parse.Object.extend("BreakoutRoom");
let PrivilegedAction = Parse.Object.extend("PrivilegedAction");
var InstancePermission = Parse.Object.extend("InstancePermission");
let LiveActivity = Parse.Object.extend("LiveActivity");
let Channel = Parse.Object.extend("Channel");
let UserProfile = Parse.Object.extend("UserProfile");


function generateRandomString(length) {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(length,
            function (err, buffer) {
                if (err) {
                    return reject(err);
                }
                var token = buffer.toString('hex');
                return resolve(token);
            });
    })
}

const sendTokenResponse = (token, roomName, res) => {
    res.set('Content-Type', 'application/json');
    res.send(
        JSON.stringify({
            token: token.toJwt(),
            roomName: roomName
        })
    );
};
let membersCache = {};
let Room = Parse.Object.extend("BreakoutRoom");
let User = Parse.Object.extend("User");

async function populateActiveChannels(conf) {
    //TODO map to a single conference?
    let roomQuery = new Parse.Query(BreakoutRoom);
    roomQuery.equalTo("conference", conf)
    roomQuery.include(["members"]);
    let rooms = await roomQuery.find({useMasterKey: true});
    return rooms;
}

var adminRole;

async function getParseAdminRole() {
    if (adminRole)
        return adminRole;
    let roleQ = new Parse.Query(Parse.Role);
    roleQ.equalTo("name", "ClowdrSysAdmin");
    adminRole = await roleQ.first({useMasterKey: true});
    return adminRole;
}

var roleCache = {};

async function getOrCreateRole(confID, priv) {
    if(typeof(confID) === 'object'){
        confID = confID.id;
    }
    let name = confID + "-" + priv;
    if (roleCache[name]){
        return roleCache[name];
    }
    try {
        var roleQ = new Parse.Query(Parse.Role);
        roleQ.equalTo("name", name);
        let role = await roleQ.first({useMasterKey: true});
        if (!role) {
            let roleACL = new Parse.ACL();

            let adminRole = await getParseAdminRole();
            roleACL.setPublicReadAccess(true);
            let newrole = new Parse.Role(name, roleACL);
            newrole.getRoles().add(adminRole);
            try {
                newrole = await newrole.save({}, {useMasterKey: true});
                console.log(newrole);
            } catch (err) {
                console.log("Did not actually create it:")
                console.log(err);
            }
            roleCache[name] = newrole;
        } else {
            roleCache[name] = role;
        }
    } catch (err) {
        console.log("Unable to create role")
        console.log(err);
        return null;
    }
    console.log("Returning: " + roleCache[name])
    console.log(roleCache[name]);
    return roleCache[name];
}

var emailsToParseUser;
var allUsersPromise;
var parseUIDToProfiles;

slackEvents.on('team_join', async (event) => {
    let conf = await getConference(event.user.team_id, "unknown");
    const parseUser = await getOrCreateParseUser(event.user.id, conf, conf.config.slackClient);

    console.log("Created parse user: " + parseUser.get("displayname") + " in " + conf.get("conferenceName"));
});


function getAllUsers() {
    if (allUsersPromise)
        return allUsersPromise;
    if (emailsToParseUser) {
        return new Promise((resolve) => resolve(emailsToParseUser));
    }
    let usersPromise = new Promise(async (resolve, reject) => {
        emailsToParseUser = {};
        try {
            let parseUserQ = new Parse.Query(Parse.User);
            parseUserQ.limit(1000);
            parseUserQ.withCount();
            let nRetrieved = 0;
            let {count, results} = await parseUserQ.find({useMasterKey: true});
            nRetrieved = results.length;
            // console.log(count);
            // console.log(results);
            results.map((u) => {
                emailsToParseUser[u.get("username")] = u;
            });
            while (nRetrieved < count) {
                // totalCount = count;
                let parseUserQ = new Parse.Query(Parse.User);
                parseUserQ.limit(1000);
                parseUserQ.skip(nRetrieved);
                let results = await parseUserQ.find({useMasterKey: true});
                // results = dat.results;
                nRetrieved += results.length;
                if (results)
                    results.map((u) => {
                        emailsToParseUser[u.get("username")] = u;
                    });
            }
            allUsersPromise = null;
            resolve(emailsToParseUser);
        }catch(err){
            console.log("In get all users ")
            console.log(err);
            reject(err);
        }
    })
    let profilesPromise = new Promise(async (resolve, reject) => {
        parseUIDToProfiles = {};
        try {
            let parseUserQ = new Parse.Query(UserProfile);
            parseUserQ.limit(1000);
            parseUserQ.withCount();
            let nRetrieved = 0;
            let {count, results} = await parseUserQ.find({useMasterKey: true});
            nRetrieved = results.length;
            // console.log(count);
            // console.log(results);
            results.map((u) => {
                if(!parseUIDToProfiles[u.get("user").id]){
                    parseUIDToProfiles[u.get("user").id] ={};
                }
                parseUIDToProfiles[u.get("user").id][u.get("conference").id] = u;
            });
            while (nRetrieved < count) {
                // totalCount = count;
                let parseUserQ = new Parse.Query(UserProfile);
                parseUserQ.limit(1000);
                parseUserQ.skip(nRetrieved);
                let results = await parseUserQ.find({useMasterKey: true});
                // results = dat.results;
                nRetrieved += results.length;
                if (results)
                    results.map((u) => {
                        if(!parseUIDToProfiles[u.get("user").id]){
                            parseUIDToProfiles[u.get("user").id] ={};
                        }
                        parseUIDToProfiles[u.get("user").id][u.get("conference").id] = u;
                    });
            }
            allUsersPromise = null;
            resolve(parseUIDToProfiles);
        }catch(err){
            console.log("In get all user profiles ")
            console.log(err);
            reject(err);
        }
    })
    allUsersPromise = Promise.all([usersPromise,profilesPromise]);
    return allUsersPromise;
}

async function addNewUsersFromSlack(conf) {
    try {
        let slackUsers = await conf.config.slackClient.users.list();
        await getAllUsers();

        let confRole = await getOrCreateRole(conf.id, "conference");
        let existingQ = confRole.getUsers().query();
        existingQ.limit(1000)
        let existingUsers = await existingQ.find({useMasterKey: true});
        let roleUsersByID = {};
        existingUsers.map((u) => {
            roleUsersByID[u.id] = 1
        });

        // console.log("OK here's the list")
        // console.log(Object.keys(emailsToParseUser));
        // return;
        let promises = [];
        if (slackUsers.members) {
            for (let user of slackUsers.members) {
                let email = user.profile.email;
                let debug = false;
                if (email) {
                    let parseUser = emailsToParseUser[email];
                    if (!parseUser || !parseUIDToProfiles[parseUser.id] || !parseUIDToProfiles[parseUser.id][conf.id]) {
                        promises.push(getOrCreateParseUser(user.id, conf, conf.config.slackClient, user).catch((e)=>{
console.log(e);
                       }));
                    } else {
                        let acl = parseUser.getACL();
                        if(acl.getPublicReadAccess())
                        {
                            acl.setPublicReadAccess(false);
                            await parseUser.save({},{useMasterKey: true});
                        }
                        //exists, just make sure that the role exists
                        if (!roleUsersByID[parseUser.id]) {
                            if(debug){
                                console.log("adding team role")
                            }
                            let modRole = await getOrCreateRole(conf.id, "moderator");

                            promises.push(ensureUserHasTeamRole(parseUser, conf, modRole));
                            roleUsersByID[parseUser.id] = 1;
                        }
                        let profile = parseUIDToProfiles[parseUser.id][conf.id];
                        // console.log(parseUIDToProfiles)
                        if(!profile.get("displayName")){
                            profile.set("displayName",user.profile.real_name);
                            promises.push(profile.save({},{useMasterKey: true}));
                        }
                    }
                    // if(conf.get("conferenceName") == "PLDI 2020" && user.profile.status_emoji==":oc"){
                    //     promises.push(ensureUserHasTeamRole(parseUser, conf, confRole));
                    // }
                }
            }
        } else {
            console.log("No slack users found for " + conf.get('conferenceName'))
        }
        await Promise.all(promises).catch(err=>{
            console.log("While fetching users");
            console.log(err);
        });
        console.log("Finished updating accounts for " + conf.get("conferenceName"))
    } catch (err) {
        console.log(err);
    }
}

async function getConference(teamID, teamDomain) {
    if(!teamID)
        return;
    try {
        if (confCache[teamID])
            return confCache[teamID];

        let q = new Parse.Query(ClowdrInstance);
        let r = undefined;
        try {
            q.equalTo("slackWorkspace", teamID);
            r = await q.first();
        } catch (err) {
            console.log(err);
        }
        // } catch (err) {
        if (!r) {
            console.log("Unable to find workspace in ClowdrDB: " + teamID + ", " + teamDomain);
        }
        r.rooms = await populateActiveChannels(r);
        r.config = await getConfig(r);
        r.twilio = Twilio(r.config.TWILIO_ACCOUNT_SID, r.config.TWILIO_AUTH_TOKEN);

        //Make sure that there is a record of the instance for enrollments
        let accessQ = new Parse.Query(ClowdrInstanceAccess);
        accessQ.equalTo("instance", r);
        let accessRecord = await accessQ.first({useMasterKey: true});
        if (!accessRecord) {
            accessRecord = new ClowdrInstanceAccess();
            let role = await getOrCreateRole(r.id, "conference");
            let acl = new Parse.ACL();
            console.log(role);
            try {
                acl.setRoleReadAccess(r.id + "-conference", true);
                accessRecord.set("instance", r);
                accessRecord.setACL(acl);
                await accessRecord.save({}, {useMasterKey: true});
            } catch (err) {
                console.log("on room " + r.id)
                console.log(err);
            }
        }

        //This is the first time we hit this conference on this run, so we should also grab the state of the world from twilio

        let roomsInTwilio = await r.twilio.video.rooms.list();
        for (let room of roomsInTwilio) {
            if (room.status == 'in-progress') {
                if (r.rooms.filter((i) => i.get("twilioID") == room.sid).length == 0) {
                    //make a new room with room.uniqueName
                    let parseRoom = new BreakoutRoom();
                    parseRoom.set("conference", r);
                    parseRoom.set("twilioID", room.sid);
                    parseRoom.set("title", room.uniqueName);
                    parseRoom.set("persistence", "ephemeral");
                    parseRoom = await parseRoom.save();
                    let acl = new Parse.ACL();
                    acl.setPublicReadAccess(false);
                    acl.setPublicWriteAccess(false);
                    acl.setRoleReadAccess(modRole, true);
                    acl.setRoleReadAccess(await getOrCreateRole(conf.id, "conference"), true);
                    parseRoom.setACL(acl, {useMasterKey: true});
                    await parseRoom.save({}, {useMasterKey: true});
                    sidToRoom[twilioRoom.sid] = parseRoom;
                    r.rooms.push(parseRoom);
                }
            }
        }

        for (let parseRoom of r.rooms) {
            try {
                console.log(parseRoom.get("title"))
                if (!parseRoom.get("twilioID") && parseRoom.get("persistence") != "ephemeral")
                    continue; //persistent room, not occupied.
                let found = roomsInTwilio.filter((i) => i.status == 'in-progress' && i.sid == parseRoom.get("twilioID"));
                if (found.length == 1 && found[0].status == 'in-progress') {
                    sidToRoom[parseRoom.get("twilioID")] = parseRoom;
                    //sync members
                    let participants = await r.twilio.video.rooms(parseRoom.get("twilioID")).participants.list();
                    for (let participant of participants) {
                        let ident = participant.identity;
                        let uid = ident.substring(0, ident.indexOf(":"));
                        let userFindQ = new Parse.Query(UserProfile);
                        try {
                            let user = await userFindQ.get(uid, {useMasterKey: true});
                            if (!parseRoom.get("members")) {
                                parseRoom.set("members", [user]);
                            } else {
                                if (parseRoom.get("members").filter((u) => u.id == uid).length == 0)
                                    parseRoom.get("members").push(user);
                            }
                        } catch (err) {
                            console.log("Missing participant: " + ident)
                            console.log(err);
                        }
                    }
                    let membersToRemove = [];
                    if (parseRoom.get("members")) {
                        for (let member of parseRoom.get("members")) {
                            let found = participants.filter((p) => {
                                let uid = p.identity.substring(0, p.identity.indexOf(':'));
                                return uid == member.id && p.status == "connected";
                            });
                            if (found.length == 0) {
                                //remove that member
                                membersToRemove.push(member.id);
                            }
                        }
                        let newMembers = parseRoom.get("members").filter((member) => !membersToRemove.includes(member.id));
                        parseRoom.set("members", newMembers);
                    }
                    await parseRoom.save({}, {useMasterKey: true});
                } else {
                    //room no logner exists
                    if (parseRoom.get("persistence") == "persistent") {
                        parseRoom.set("twilioID", null);
                        await parseRoom.save({}, {userMasterKey: true});
                    } else {
                        await parseRoom.destroy({useMasterKey: true});
                        r.rooms = r.rooms.filter((r) => r.id != parseRoom.id);
                    }
                }
            } catch (err) {
                console.log("initialization error on " + parseRoom.id)
                console.log(err);
            }
        }

        // if (!process.env.SKIP_INIT)
            await addNewUsersFromSlack(r);

        let adminRole = await getParseAdminRole();
        let adminsQ = adminRole.getUsers().query();
        adminsQ.limit(1000);
        let admins = await adminsQ.find({useMasterKey: true});
        let promises = [];
        for (let admin of admins) {
            promises.push(ensureUserHasTeamRole(admin, r, await getOrCreateRole(r.id, "conference")));
        }
        await Promise.all(promises).catch((err)=>{
            console.log(err);
        });

        let allChannels = await r.config.slackClient.conversations.list({types: "private_channel,public_channel"});
        for(let channel of allChannels.channels){
            if(channel.name=="moderators"){
                r.moderatorChannel = channel.id;
            }
            else if(channel.name =="technical-support"){
                r.techSupportChannel = channel.id;
            }
        }
        confCache[teamID] = r;
        return r;
    }catch(err){
        console.log("In get conference")
        console.log(err);
        return null;
    }
}
var userNotifications = {};

async function pushToUserStream(parseUser, parseConference, topic) {
    let activtyData;
    if (!userNotifications[parseUser.id] || !userNotifications[parseUser.id][parseConference.id] ||
        (topic && !userNotifications[parseUser.id][parseConference.id][topic])) {

        let liveActivityQ = new Parse.Query("LiveActivity");
        liveActivityQ.equalTo("user",parseUser);
        liveActivityQ.equalTo("conference", parseConference);
        liveActivityQ.equalTo("topic", topic);
        activtyData= await liveActivityQ.first({useMasterKey: true});
        if(!activtyData){
            activtyData = new LiveActivity();
            activtyData.set("user", parseUser);
            activtyData.set("conference", parseConference);
            activtyData.set("topic", topic);
            let acl = new Parse.ACL();
            acl.setPublicReadAccess(false);
            acl.setReadAccess(parseUser, true);
            activtyData.setACL(acl);
        }
        if(!userNotifications[parseUser.id])
            userNotifications[parseUser.id] ={};
        if(!userNotifications[parseUser.id][parseConference.id])
            userNotifications[parseUser.id][parseConference.id] = {};
        userNotifications[parseUser.id][parseConference.id][topic] = activtyData;
    } else {
        activtyData = userNotifications[parseUser.id][parseConference.id][topic];
    }
    await activtyData.save({}, {useMasterKey: true});

}
async function getConfig(conf) {
    let q = new Parse.Query(InstanceConfig)
    q.equalTo("instance", conf);
    let res = await q.find({useMasterKey: true});
    let config = {};
    for (let obj of res) {
        config[obj.get("key")] = obj.get("value");
    }
    if (!config.FRONTEND_URL) {
        config.FRONTEND_URL = "https://staging.clowdr.org"
    }
    // if (!config.TWILIO_CALLBACK_URL) {
        // config.TWILIO_CALLBACK_URL = "https://clowdr.herokuapp.com/twilio/event"
        config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/twilio/event" //TODO
    // }
    if (!config.TWILIO_ROOM_TYPE) {
        config.TWILIO_ROOM_TYPE = "group";
    }
    if (!config.AUTO_CREATE_USER) {
        config.AUTO_CREATE_USER = true;
    }
    // config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/twilio/event";
    config.slackClient = new WebClient(config.SLACK_BOT_TOKEN);

    // console.log(JSON.stringify(config,null,2))
    return config;
}

var userIDToSession = {};
var roomCache = {};
async function pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, teamID) {

    let sessionToken = userIDToSession[parseUser.id];
    if(!sessionToken){
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("user", parseUser);
        let parseSession = await userQ.first({useMasterKey: true});
        sessionToken = parseSession.getSessionToken();
        userIDToSession[parseUser.id] = sessionToken;
    }
    let rooms = roomCache[parseUser.id];
    if(!rooms){
        const accesToConf = new Parse.Query(InstancePermission);
        accesToConf.equalTo("conference", conf);
        accesToConf.equalTo("action", privilegeRoles['access-from-slack']);
        const hasAccess = await accesToConf.first({sessionToken: sessionToken});
        if(!hasAccess){
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "Sorry, this feature is not yet enabled."
                }
            })
            roomCache[parseUser.id] = "no-access";
            return;
        }

        let query = new Parse.Query(BreakoutRoom);
        query.include("members");
        query.equalTo("conference", conf);
        query.limit(100);
        rooms = await query.find({sessionToken: sessionToken});
        roomCache[parseUser.id] = rooms;
    }
    else if(rooms == "no-access"){
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: "Sorry, this feature is not yet enabled."
            }
        })
        roomCache[parseUser.id] = "no-access";
        return;
    }

    if (rooms.length == 0) {
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: "Nobody is in a video call yet. To create a new room, create a new message `/video [name of room to join or create]`"
            }
        })
        return;
    }
    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: rooms.length + " video room" + (rooms.length > 1 ? 's are' : ' is') + " up right now (this list includes all public rooms and all private rooms to which you have access). " +
                "Join one of these, or create a new room by sending a new message `/video [name of room to join or create]`"
        }
    })
    for (let room of rooms) {
        let membersString = "";
        if (room.get("members")) {
            for (let member of room.get("members")) {
                if (member.get("slackID"))
                    membersString += "<@" + member.get("slackID") + ">,"
            }
        }
        if (membersString.length > 0) {
            membersString = membersString.substring(0, membersString.length - 1);
        } else {
            membersString = "(Empty)"
        }
        let joinAccy;

        const link = await buildLink(room.id, room.get("title"), parseUser, conf, teamID);
        joinAccy = {
            type: "button",
            action_id: "join_video",
            value: room.id,
            url: link,
            text: {
                type: "plain_text",
                text: "Join Video"
            }
        }
        let block = {
            type: "section",
            text: {
                type: "mrkdwn",
                text: room.get("title") + ": " + membersString,
            },
            accessory: joinAccy
        }
        blocks.push(block);
    }
    // console.log(JSON.stringify(blocks, null, 2));
}

async function ensureUserHasTeamRole(user, conf, role) {
    let confID = conf.id;
    // console.trace()
    if (userToWorkspaces[user.id] && userToWorkspaces[user.id][conf.id]) {
        return;
    }
    let debug =false;
    if(debug) {
        console.log("EUHTR")
        console.log(user.id);
    }
    try {
        //Check in DB
        const roleQuery = new Parse.Query(Parse.Role);
        roleQuery.equalTo("users", user);
        roleQuery.equalTo("id", role.id);
        if(!role.id){
            console.log("invalid role?")
            console.log(role);
            console.trace();
        }
        const roles = await roleQuery.find({useMasterKey: true});
        if (!roles || roles.length == 0) {
            role.getUsers().add(user);
            await role.save({}, {useMasterKey: true});
        }else if(debug){
            console.log("Already has role? "+ user.id)
        }
        if (!userToWorkspaces[user.id]) {
            userToWorkspaces[user.id] = {};
        }
        userToWorkspaces[user.id][conf.id] = 1;
    }catch(err){
        console.log("Error in role")
        console.log(err);
    }
}

var privilegeRoles = {
    "createVideoRoom": null,
    "chat": null,
    "access-from-slack": null,
    "createVideoRoom-persistent": null,
    "createVideoRoom-group": null,
    "createVideoRoom-smallgroup": null,
    "createVideoRoom-peer-to-peer": null,
    'createVideoRoom-private': null
};

async function createPrivileges() {
    return Promise.all(Object.keys(privilegeRoles).map(async (action) => {
            let actionsQ = new Parse.Query(PrivilegedAction);
            actionsQ.equalTo("action", action)
            actionsQ.include("role");
            let res = await actionsQ.first({useMasterKey: true});
            if (!res) {
                let pa = new PrivilegedAction();
                pa.set("action", action);
                res = await pa.save({}, {useMasterKey: true});
            }
            privilegeRoles[action] = res;
        }
    ));
}

async function getOrCreateParseUser(slackUID, conf, slackClient, slackProfile) {
    //First try retrieving by slack ID
    let q = new Parse.Query(UserProfile);
    q.equalTo("slackID", slackUID);
    q.equalTo("conference", conf);

    let profile = await q.first({useMasterKey: true});
    if (profile) {
        await ensureUserHasTeamRole(profile.get("user"), conf, await getOrCreateRole(conf, "conference"));
        // if (!profile.get("profilePhoto")) {
        //     if(!slackProfile){
        //         slackProfile = await conf.config.slackClient.users.profile.get({user: slackUID});
        //     }
        //     if(slackProfile.profile.image_512) {
        //         try {
        //             let url = slackProfile.profile.image_512;
        //             let extension = slackProfile.profile.image_512.substring(slackProfile.profile.image_512.length-3);
        //             let file = new Parse.File("slack-profile-photo"+slackUID+"."+extension, {
        //                 uri: url
        //             });
        //             let res = await file.save({useMasterKey: true});
        //             profile.set("profilePhoto", res);
        //             await profile.save({},{useMasterKey: true})
        //         } catch (err) {
        //             console.log(err)
        //         }
        //     }
        // }
        return profile.get("user");
    }
    //Now try to retrieve by email

    try {
        let user_info = await slackClient.users.info({user: slackUID});
        q = new Parse.Query(Parse.User);
        q.equalTo("email", user_info.user.profile.email);
        let u = await q.first({useMasterKey: true});
        if (u) {
            //Just create the profile
            console.log("Creating profile " + slackUID);
            let profile = new UserProfile();
            profile.set("user", u);
            profile.set("conference", conf);
            profile.set("slackID", slackUID);
            profile.set("displayName", slackProfile.profile.real_name);
            let profileACL = new Parse.ACL();
            profileACL.setRoleReadAccess(await getOrCreateRole(conf.id,"conference"), true);
            profileACL.setWriteAccess(u, true);
            profile.setACL(profileACL);
            if(!slackProfile){
                slackProfile = await conf.config.slackClient.users.profile.get({user: slackUID});
            }
            // if(slackProfile.profile && slackProfile.profile.image_512) {
            //     try {
            //         let url = slackProfile.profile.image_512;
            //         let extension = slackProfile.profile.image_512.substring(slackProfile.profile.image_512.length-3);
            //         let fileName = "slack-profile-photo-"+slackUID+"."+extension;
            //         let file = new Parse.File(fileName, {
            //             uri: url
            //         });
            //         let res = await file.save({useMasterKey: true});
            //         profile.set("profilePhoto", res);
            //         profile.save({},{useMasterKey: true})
            //     } catch (err) {
            //         profile.set("profilePhoto", undefined)
            //         // console.log(err)
            //     }
            // }
            await profile.save({}, {useMasterKey: true});
            await ensureUserHasTeamRole(u, conf, await getOrCreateRole(conf, "conference"));
            u.get("profiles").add(profile);
            await u.save({}, {useMasterKey: true});
            return u;
        }
        // if (!conf.config.AUTO_CREATE_USER) {
        //     console.log("AUTO CREATE IS DISABLED!")
        //     return null; //TODO send an error back to the user, include the email address and conference name
        // }
        let user = await createParseUserAndEnsureRole(user_info.user, conf, await getOrCreateRole(conf.id, "conference"));
        let profile = new UserProfile();
        profile.set("user", user);
        profile.set("conference", conf);
        profile.set("slackID", slackUID);
        let profileACL = new Parse.ACL();
        profileACL.setRoleReadAccess(await getOrCreateRole(conf.id,"conference"), true);
        profileACL.setWriteAccess(user, true);
        profile.setACL(profileACL);
        // if(!slackProfile){
        //     slackProfile = await conf.config.slackClient.users.profile.get({user: slackUID});
        // }
        // if(slackProfile.profile.image_512) {
        //     try {
        //         let url = slackProfile.profile.image_512;
        //         let extension = slackProfile.profile.image_512.substring(slackProfile.profile.image_512.length-3);
        //         let file = new Parse.File("slack-profile-photo"+slackUID+"."+extension, {
        //             uri: url
        //         });
        //         let res = await file.save({useMasterKey: true});
        //         profile.set("profilePhoto", res);
        //         profile.save({},{useMasterKey: true})
        //     } catch (err) {
        //         profile.set("profilePhoto", undefined);
        //         console.log("Bailed on saving profile.")
        //         // console.log(err)
        //     }
        // }
        profile = await profile.save({}, {useMasterKey: true});
        let relation = user.relation("profiles");
        relation.add(profile);

        let userACL = new Parse.ACL();
        userACL.setWriteAccess(user, true);
        userACL.setReadAccess(user, true);
        user.setACL(userACL);
        await user.save({}, {useMasterKey: true});
        return user;
    } catch (err) {
        console.log("Unable to create user "+ slackUID)
        console.log(err);
        return null;
    }
}

async function createParseUserAndEnsureRole(slackUser, conf, role) {
    //Fallback. Create a new user in parse to represent this person.
    let user = new Parse.User();
    user.set("username", slackUser.profile.email);
    user.set("displayname", slackUser.profile.real_name);
    user.set("password", slackUser.profile.email + Math.random());
    user.set("email", slackUser.profile.email);
    user = await user.signUp({}, {useMasterKey: true});
    await ensureUserHasTeamRole(user, conf, role);
    let userACL = new Parse.ACL();
    userACL.setWriteAccess(user, true);
    userACL.setReadAccess(user, true);
    userACL.setPublicReadAccess(false);
    user.setACL(userACL);
    await user.save({},{useMasterKey: true})
    return user;
}

async function generateHome(conf, parseUser, teamID) {
    let q = new Parse.Query(SlackHomeBlocks);
    q.equalTo("conference", conf);
    q.addAscending("sortKey");
    let dbBlocks = await q.find();
    let blocks = [];

    for (let b of dbBlocks) {
        blocks.push({
            type: "section",
            text: {
                type: b.get('type'),
                text: b.get('content')
            }
        })
    }
    blocks.push({
        type: 'divider'
    });

    await pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, teamID);

    let view = {
        type: 'home',
        title: {
            type: 'plain_text',
            text: conf.get("conferenceName") + " LIVE @CLOWDR"
        },
        blocks: blocks
    }
    // console.log(view.title.text);
    return view;
}

async function buildLink(roomID, roomName, parseUser, conf, teamID) {

    let link = conf.config.FRONTEND_URL;
    if (link.endsWith('/'))
        link = link.substring(0, link.length - 1);
    if (!userToAuthData[parseUser.id]) {
        let secret = await generateRandomString(48);
        userToAuthData[parseUser.id] = secret;
        parseUser.set("loginKey", secret);
        parseUser.set("loginExpires", moment().add("8", "hours").toDate());
        await parseUser.save({}, {useMasterKey: true});
    }
    let token = jwt.sign({
        uid: parseUser.id,
        team: teamID,
        secret: userToAuthData[parseUser.id],
        roomName: roomName,
    }, process.env.CLOWDR_JWT_KEY, {expiresIn: '8h'});

    link = link + '/fromSlack/' + encodeURI(teamID) + '/' + encodeURI(roomName) + '/' +
        encodeURI(token);
    return link;
}

function respondWithError(response_url, error) {
    const message = {
        "text": "Sorry, I was unable to process your request. " + error,
        "response_type": "ephemeral",
    };

    return axios.post(response_url, message
    ).catch(console.error);
}

function sendMessageWithLinkToUser(response_url, messageText,conf, linkText, link) {
    let techSupportRoom = conf.techSupportChannel;
    const message = {
        "text": messageText, //+". <"+link+"|"+linkText+">",
        "response_type": "ephemeral",
        // Block Kit Builder - http://j.mp/bolt-starter-msg-json
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": messageText + (link ? " <" + link + "|" + linkText + ">" : ""),
                }
            },
        ],
        "attachments": [{
            "text": (link?"Please make sure to open this link in Chrome or Safari (sorry, the mobile-embedded browser won't work, and Firefox will not work very well). " : "")+ (techSupportRoom ? "Having trouble with technical issues? Come join <#"+techSupportRoom+">.":"")
        }]
    };
    if(link){
        // message.blocks.push(  {
        //     "type": "actions",
        //     "block_id": "actions1",
        //     "elements": [
        //
        //         {
        //             "type": "button",
        //             "text": {
        //                 "type": "plain_text",
        //                 "text": linkText
        //             },
        //             "action_id": "join_call_clicked",
        //             "value": "click_me_123",
        //             "url": link
        //         }]
        // });
    }

    return axios.post(response_url, message);
}

async function sendModeratorMessageFromSlack(conf, slackUID, message){
    let slack = conf.config.slackClient;
    let channel = await getModeratorChannel(conf);
    await conf.config.slackClient.chat.postMessage({channel: channel,
        text: "Moderation request from slack",
        blocks:[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "A moderation request was received from <@"+slackUID+"> in slack:"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": ">"+message
                }
            }
        ]
    })


}
async function sendJoinLinkToUser(body, roomName, isPrivate) {
    if (!roomName) {
        respondWithError(body.response_url, "You need to specify a room name");
        return;
    }
    if (roomName.startsWith("!")) {
        respondWithError(body.response_url, "Room names can not begin with special characters")
        return;
    }
    let conf = await getConference(body.team_id, body.team_domain)
    let slackClient = conf.config.slackClient;
    const parseUser = await getOrCreateParseUser(body.user_id, conf, slackClient);

    //Make sure that the user has access...
    let sessionToken = userIDToSession[parseUser.id];
    if(!sessionToken){
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("user", parseUser);
        let parseSession = await userQ.first({useMasterKey: true});
        sessionToken = parseSession.getSessionToken();
        userIDToSession[parseUser.id] = sessionToken;
    }

    const accesToConf = new Parse.Query(InstancePermission);
    accesToConf.equalTo("conference", conf);
    accesToConf.equalTo("action", privilegeRoles['access-from-slack']);
    const hasAccess = await accesToConf.first({sessionToken: sessionToken});
    if(!hasAccess){
        respondWithError(body.response_url,"You do not currently have access to video rooms at " + conf.get("conferenceName"));
        return;
    }

    const link = await buildLink(null, roomName, parseUser, conf, body.team_id);
    await sendMessageWithLinkToUser(body.response_url, "Finish creating or joining the live video call '" + roomName + "' here! :tv: Remember to keep Slack open too to keep the conversation going here!", conf, "Join Call", link);

}

slackInteractions.action({action_id: "join_video"}, async (payload, respond) => {

    await respond({});

    return {}
});

slackEvents.on("app_home_opened", async (payload) => {
    if (!payload.view)
        return;
    let team_id = payload.view.team_id;
    let conf = await getConference(team_id)
    // console.log(conf);

    const parseUser = await getOrCreateParseUser(payload.user, conf, conf.slackClient);
    const args = {
        token: conf.config.SLACK_BOT_TOKEN,
        user_id: payload.user,
        view: await generateHome(conf, parseUser, payload.view.team_id)
    };

    const result = await axios.post('https://slack.com/api/views.publish', JSON.stringify(args), {
        headers: {
            "Authorization": "Bearer " + conf.config.SLACK_BOT_TOKEN,
            'Content-Type': 'application/json'
        }
    });
});

// async function sendLoginLinkToUser(conf, body){
//     const parseUser = await getOrCreateParseUser(body.user_id, conf, conf.config.slackClient);
//     let secret = await generateRandomString(48);
//     let token = jwt.sign({
//         identity: body.user_id,
//         team: conf.id,
//         secret: secret
//     }, process.env.CLOWDR_JWT_KEY, {expiresIn: '10m'});
//     try {
//         let myAuthData ={id: secret,
//         user: body.user_id};
//
//         // let link = conf.config.FRONTEND_URL;
//         // if (link.endsWith('/'))
//         //     link = link.substring(0, link.length - 1);
//         let link = "http://localhost:3000/slack"
//         link = link + "/login/" + encodeURI(body.user_id) + "/" + encodeURI(secret);
//         await sendMessageWithLinkToUser(body.response_url, "Almost there! Just one more step to be logged in to live.clowdr.org:", "Login", link);
//     } catch (err) {
//         console.log(err);
//     }
//
//
// }


async function slackSlashCommand(req, res, next) {
    let teamID = req.body.team_id;
    res.status(200).end();
    let conf = await getConference(req.body.team_id, req.body.team_domain)
    //
    // if(req.body.command == "/login"){
    //     res.send();
    //     console.log(req.body);
    //     await sendLoginLinkToUser(conf, req.body);
    // }
    if(req.body.command === "/saysomething" || req.body.command == "/moderator"){
        try {
            await sendModeratorMessageFromSlack(conf, req.body.user_id, req.body.text)
            sendMessageWithLinkToUser(req.body.response_url,"Your message has been received by the moderators. They will contact you ASAP to follow up. " +
                " Please note that since moderators are volunteers, we are unable to provide 24/7 moderation service," +
                " but will do our best to address every complaint as quickly as possible, and will be sure to follow up" +
                " to every report.", conf)
        }catch(err){
            console.log(err);
            sendMessageWithLinkToUser(req.body.response_url, "An internal error occurred while sending your message. Please try again or email the organizers. ", conf);

        }

        return;
    }
    if(req.body.command === "/videodebug"){
        req.body.command = "/video";
        req.body.user_id = "U014VSQ8HDK";
        console.log(req.body.user_id)
    }
    if (req.body.command === '/video_t' || req.body.command === '/video' || req.body.command === '/videoprivate' || req.body.command == "/videolist") {
        res.send();

        try {
            if (req.body.text) {
                await sendJoinLinkToUser(req.body, req.body.text, (req.body.command === "/videoprivate"));
            } else {
                const parseUser = await getOrCreateParseUser(req.body.user_id, conf, conf.config.slackClient);
                let blocks = [];

                await pushActiveCallsFromConfToBlocks(conf, blocks, parseUser, req.body.team_id);
                const message = {
                    "text": "Live video information",
                    "response_type": "ephemeral",
                    // Block Kit Builder - http://j.mp/bolt-starter-msg-json
                    "blocks": blocks
                };


                await axios.post(req.body.response_url, message
                ).catch(console.error);
            }
        } catch (err) {
            console.log("Error procesing command")
            console.log(err);
        }
    } else {
        next();
    }
}

async function processTwilioEvent(req, res) {
    let roomSID = req.body.RoomSid;
    try {
        let room = sidToRoom[roomSID];
        if (req.body.StatusCallbackEvent == 'participant-connected') {
            let uid = req.body.ParticipantIdentity.substring(0, req.body.ParticipantIdentity.indexOf(":"));
            let userFindQ = new Parse.Query(UserProfile);
            console.log("LF .. " + uid);
            let user = await userFindQ.get(uid, {useMasterKey: true});
            console.log("Found user .. " + uid);
            if (!room.get("members")) {
                room.set("members", [user]);
            } else {
                if (room.get("members").filter((u) => u.id == uid).length == 0)
                    room.get("members").push(user);
            }
            await room.save({}, {useMasterKey: true});


            // let newUser = await roomsRef.child(req.body.RoomName).child("members").child(uid).set(true);
            // console.log("Added " + req.body.ParticipantIdentity + " to " + roomDBID + " count is now " + membersCache[roomDBID]);
            // ;
            // membersCache[req.body.RoomName]++;
        } else if (req.body.StatusCallbackEvent == 'participant-disconnected') {
            let uid = req.body.ParticipantIdentity.substring(0, req.body.ParticipantIdentity.indexOf(":"));
            let userFindQ = new Parse.Query(User);
            if (!room.get("members")) {
                room.set("members", []);
            } else {
                room.set("members", room.get("members").filter((u) => u.id != uid));
            }
            await room.save({}, {useMasterKey: true});
            // } else if(req.body.StatusCallbackEvent == '')
        } else if (req.body.StatusCallbackEvent == 'room-ended') {
            if (room) {
                if (room.get("persistence") == "persistent") {
                    console.log("Removing tid " + room.get("title"))
                    room.set("twilioID", null);
                    await room.save({}, {useMasterKey: true});
                } else {
                    //delete the live activity
                    await room.destroy({useMasterKey: true});
                }
            } else {
                console.log("unable to destroy " + roomSID);
            }
        } else {
        }
    } catch
        (err) {
        console.log(err);
        // next(err);

    }
    res.send();
}

app.post("/twilio/event", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    await processTwilioEvent(req, res);
})

async function addOrReplaceConfig(installTo, key, value) {
    let existingTokenQ = new Parse.Query(ClowdrInstance);
    existingTokenQ.equalTo("key", key);
    existingTokenQ.equalTo("instance", installTo);
    let tokenConfig = await existingTokenQ.first();
    if (!tokenConfig) {
        //Add the token
        tokenConfig = new InstanceConfig();
        tokenConfig.set("key", key);
        tokenConfig.set("instance", installTo);
    }
    tokenConfig.set("value", value);
    return tokenConfig.save();
}

app.get("/slack/auth", async (req, res) => {

    axios.post("https://slack.com/api/oauth.v2.access", qs.stringify({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code: req.query.code
    })).then(async (resp) => {
        console.log("Signup:")
        console.log(resp.data);
        // console.log(req.query.code);
        if (!resp.data.ok) {
            return res.send(403, resp.data);
        }
        let q = new Parse.Query(ClowdrInstance);
        q.equalTo("pendingWorkspaceName", resp.data.team.name);
        let q2 = new Parse.Query(ClowdrInstance);
        q2.equalTo("slackWorkspace", resp.data.team.id);
        let mainQ = Parse.Query.or(q, q2);
        let installTo = await mainQ.first();
        if (!installTo) {
            installTo = new ClowdrInstance();
            installTo.set("slackWorkspace", resp.data.team.id);
            installTo.set("conferenceName", resp.data.team.name)
            await installTo.save();
            //create the sub account
            let account = await masterTwilioClient.api.accounts.create({friendlyName: installTo.id + ": " + resp.data.team.name});
            let newAuthToken = account.authToken;
            let newSID = account.sid;

            let tempClient = Twilio(newSID, newAuthToken);
            let new_key = await tempClient.newKeys.create();
            await addOrReplaceConfig(installTo, "TWILIO_API_KEY", new_key.sid);
            await addOrReplaceConfig(installTo, "TWILIO_API_SECRET", new_key.secret);
            await addOrReplaceConfig(installTo, "TWILIO_ACCOUNT_SID", newSID);
            await addOrReplaceConfig(installTo, "TWILIO_AUTH_TOKEN", newAuthToken);
            await addOrReplaceConfig(installTo, "TWILIO_ROOM_TYPE", "peer-to-peer")
        }

        installTo.set("slackWorkspace", resp.data.team.id);
        installTo.set("pendingWorkspaceName", null);
        await addOrReplaceConfig(installTo, "SLACK_BOT_TOKEN", resp.data.access_token);
        await addOrReplaceConfig(installTo, "SLACK_BOT_USER_ID", resp.data.bot_user_id);
        // await addOrReplaceConfig("SLACK_BOT_ID", resp.data.access_token);


        //Delete any tokens that exist


        await installTo.save();
        // res.send("Installation success. Please email Jonathan Bell at jon@jonbell.net to complete setup.");
        res.redirect("https://www.clowdr.org/beta_success.html");
    })
});

async function checkToken(token) {
    console.log(token);


    let query = new Parse.Query(Parse.Session);
    query.include("user");
    query.equalTo("sessionToken", token);
    let session = await query.first();
    if (session) {
        let name = session.get("user").get("displayname");
        let id = session.get("user").id;
        return id + ":" + name;
    }
    return undefined;
}

app.post("/video/new", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
  return await createNewRoom(req, res);
});
async function createNewRoom(req, res){
    roomCache = {};
    //Validate parse user can create this room
    let token = req.body.identity;
    // let conf = req.body.conf;
    // let confID = req.body.confid;
    let teamName = req.body.slackTeam;
    let conf = await getConference(teamName);
    let roomName = req.body.room;
    let twilio = conf.twilio;
    let visibility = req.body.visibility;
    let category = req.body.category //TODO
    let mode = req.body.mode;
    let persistence = req.body.persistence;
    if (!mode)
        mode = "group-small";
    if (!persistence)
        persistence = "ephemeral";


    try {
        let query = new Parse.Query(Parse.Session);
        // console.log(token);
        query.include("user");
        query.equalTo("sessionToken", token);
        let session = await query.first({useMasterKey: true});
        if (session) {
            let parseUser = session.get("user");
            //Validate has privileges for conference
            const accesToConf = new Parse.Query(InstancePermission);
            accesToConf.equalTo("conference", conf);
            accesToConf.equalTo("action", privilegeRoles['createVideoRoom']);
            //TODO access-check for each option, too, but I don't have time now...
            const hasAccess = await accesToConf.first({sessionToken: token});
            if (hasAccess && hasAccess.id) {
                //Try to create the room
                try {
                    console.log("creating room with callback" + conf.config.TWILIO_CALLBACK_URL)
                    console.log("For " + parseUser.id + ": " + parseUser.get("displayname"))
                    console.log(roomName)
                    let maxParticipants = (mode == "peer-to-peer" ? 10 : (mode == "small-group" ? 4 : 24));
                    let twilioRoom = await twilio.video.rooms.create({
                        type: mode,
                        // type: conf.config.TWILIO_ROOM_TYPE,
                        uniqueName: roomName,
                        maxParticipants: maxParticipants,
                        statusCallback: conf.config.TWILIO_CALLBACK_URL
                    });
                    //Create a new room in the DB
                    let parseRoom = new BreakoutRoom();
                    parseRoom.set("title", roomName);
                    parseRoom.set("conference", conf);
                    parseRoom.set("twilioID", twilioRoom.sid);
                    parseRoom.set("isPrivate", visibility=="unlisted");
                    parseRoom.set("persistence", persistence);
                    parseRoom.set("mode", mode);
                    parseRoom.set("capacity", maxParticipants);
                    let modRole = await getOrCreateRole(conf.id,"moderator");

                    let acl = new Parse.ACL();
                    acl.setPublicReadAccess(false);
                    acl.setPublicWriteAccess(false);
                    acl.setRoleReadAccess(modRole, true);
                    if (visibility == "unlisted") {
                        acl.setReadAccess(parseUser.id, true);
                    }
                    else{
                        acl.setRoleReadAccess(await getOrCreateRole(conf.id,"conference"), true);
                    }
                    parseRoom.setACL(acl, {useMasterKey: true});
                    await parseRoom.save({}, {useMasterKey: true});
                    sidToRoom[twilioRoom.sid] = parseRoom;
                    conf.rooms.push(parseRoom);
                    return res.send({status: "OK"});
                } catch (err) {
                    console.log(err);
                    return res.send({
                        status: "error",
                        message: "There is already a video room with this name (although it may be private, and you can't see it). Please either join the existing room or pick a new name."
                    });
                }
            } else {
                return res.send({
                    status: "error",
                    message: "Sorry, you do not currently have access to create video rooms for " + conf.get("conferenceName")
                });
            }

        }
    } catch (err) {
        console.log(err);
        return res.send({status: "error", message: "Internal server error "});
    }
    return res.send({
        status: "error",
        message: "Could not find enrollment for this user on this conference, " + conf
    });
}

async function removeFromCall(twilio, roomSID, parseUser) {
    let idToRemove = parseUser.id + ":" + parseUser.get("displayname");
    try {
        let participant = await twilio.video.rooms(roomSID).participants(idToRemove).update({status: 'disconnected'})
    } catch (err) {
        //might not be in room still.
    }
}
async function updateACL(req,res){
    try {
        roomCache = {};
        let identity = req.body.identity;
        const roomID = req.body.roomID;
        const conference = req.body.slackTeam;
        const users = req.body.users;
        let conf = await getConference(conference);
        let userQ = new Parse.Query(Parse.Session);
        userQ.equalTo("sessionToken", identity);
        userQ.include(["user.displayname"]);
        let parseSession = await userQ.first({useMasterKey: true});
        let parseUser = parseSession.get("user");
        //Check for roles...
        let roomQ = new Parse.Query("BreakoutRoom");
        let room = await roomQ.get(roomID, {sessionToken: identity});
        if (!room) {
            return res.send({status: 'error', message: "No such room"});
        }
        let usersWithAccessCurrently = Object.keys(room.getACL().permissionsById).filter(v=>!v.startsWith("role"));

        let uq = new Parse.Query(Parse.User);
        let usersToRefresh = [];
        let promises = [];
        for (let uid of usersWithAccessCurrently) {
            if (!users.includes(uid)) {
                room.getACL().setReadAccess(uid, false);
                let user = await uq.get(uid,{useMasterKey: true});
                promises.push(removeFromCall(conf.twilio, room.get("twilioID"), user));
                usersToRefresh.push(user);
            }
        }
        for (let user of users) {
            if (!usersWithAccessCurrently.includes(user)) {
                room.getACL().setReadAccess(user,true);
                let fauxUser = new Parse.User();
                fauxUser.id = user;
                usersToRefresh.push(fauxUser);
            }
        }

        await room.save({}, {useMasterKey: true});
        for(let user of usersToRefresh){
            promises.push(pushToUserStream(user, conf, "privateBreakoutRooms"));
        }
        await Promise.all(promises);
        res.send({status: "OK"});
    } catch (err) {
        console.log(err);
        res.send({status: "error", message: "Internal server error"});
    }
}
async function getModeratorChannel(conf){
    return conf.moderatorChannel;
}
async function sendModeratorMessage(req,res){
    let identity = req.body.identity;
    const roomID = req.body.roomID;
    const conference = req.body.slackTeam;
    const participants = req.body.participants;
    let conf = await getConference(conference);
    let userQ = new Parse.Query(Parse.Session);
    userQ.equalTo("sessionToken", identity);
    let parseSession = await userQ.first({useMasterKey: true});
    let parseUser = parseSession.get("user");
    let profileQ = new Parse.Query(UserProfile);
    profileQ.equalTo("user", parseUser);
    profileQ.equalTo("conference", conf);
    let profile = await profileQ.first({useMasterKey: true});
    //Check for roles...
    let roomQ = new Parse.Query("BreakoutRoom");
    let room = await roomQ.get(roomID, {sessionToken: identity});
    if (!room) {
        return res.send({status: 'error', message: "No such room"});
    }
    let unfilledUsers = [];
    for(let id of participants){
        unfilledUsers.push(UserProfile.createWithoutData(id));
    }
    let users = await Parse.Object.fetchAll(unfilledUsers, {useMasterKey: true});
    let usersString = "";
    for(let user of users){
        usersString += "<@"+user.get("slackID")+">, ";
    }
    if(usersString.length > 0){
        usersString = usersString.substring(0,usersString.length - 2);
    }
    //Compose and send a message on slack.
    let slack = conf.config.slackClient;
    let channel = await getModeratorChannel(conf);
    await conf.config.slackClient.chat.postMessage({channel: channel,
        text: "Moderation request from web",
        blocks:[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "A moderation request was received from <@"+profile.get("slackID")+"> " +
                        " while in the web chat room titled: '"+room.get("title")+"', which contained at the time " +
                        "the following users: " + usersString + ". Message follows:"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": ">"+req.body.message.replace("\n","\n>")
                }
            }
        ]
    })



    res.send({status: "OK"});
}
app.post("/moderator/fromVideo", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    try {
        await sendModeratorMessage(req, res);
    }catch(err){
        res.status(500);
        res.send({status: "error", message: "An internal server error occurred."})
        console.log(err);
    }
})
app.post("/video/acl", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    await updateACL(req, res);
})
app.post("/video/token", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    try {
        await mintTokenForFrontend(req, res);
    } catch (err) {
        console.log("Not found when minting")
        console.log(err);
        res.status(500);
        res.send({status: "error", message: "Internal server error"});
    }

});
async function createTwilioRoomForParseRoom(parseRoom, conf){
    let twilioRoom = await conf.twilio.video.rooms.create({
        type: parseRoom.get("mode"),
        uniqueName: parseRoom.get("title"),
        statusCallback: conf.config.TWILIO_CALLBACK_URL
    });
    return twilioRoom;
}
async function mintTokenForFrontend(req, res) {
    console.log("TOken requested")
    let identity = req.body.identity;
    const room = req.body.room;
    const conference = req.body.conf;
    let conf = await getConference(conference);
    let userQ = new Parse.Query(Parse.Session);
    console.log(identity);
    userQ.equalTo("sessionToken", identity);
    userQ.include(["user.displayname"]);
    // console.log(identity)
    let parseSession = await userQ.first({useMasterKey: true});
    let parseUser = parseSession.get("user");
    let userProfileQ = new Parse.Query(UserProfile);
    userProfileQ.equalTo("user", parseUser);
    userProfileQ.equalTo("conference", conf);
    let userProfile = await userProfileQ.first({useMasterKey: true});
    identity = userProfile.id + ":" + parseUser.get("displayname");
    console.log(identity);
    // console.log(parseSession);
    // console.log(parseSession.get("user"))


    // console.log("Get token for video for " + identity + " " + room)
    if (!room) {
        res.status(404);
        res.error();
    }
    let query = new Parse.Query("BreakoutRoom");
    let roomData = await query.get(room, {sessionToken: req.body.identity});
    if (!roomData.get("twilioID")) {
        if (roomData.get("persistence") == "persistent") {
            //Create a new twilio room
            try {
                let twilioRoom = await createTwilioRoomForParseRoom(roomData, conf);
                roomData.set("twilioID", twilioRoom.sid);
                await roomData.save({}, {useMasterKey: true});
                sidToRoom[twilioRoom.sid] = roomData;
            } catch (err) {
                //If an error ocurred making the twilio room, someone else must have updated it.
                console.log(err);
                let twilioRoom = await conf.twilio.video.rooms(roomData.get("title")).fetch();
                roomData.set("twilioID", twilioRoom.sid)
                await roomData.save({}, {useMasterKey: true});
                sidToRoom[twilioRoom.sid] = roomData;
            }
        } else {
            res.status(404);
            return res.send({message: "This room has been deleted"});
        }
    }
    let newNode = {};
    if (!roomData) {
        res.status(403);
        res.error();
    }
    const token = videoToken(identity, roomData.get('twilioID'), conf.config);
    // console.log("Sent response" + token);
    sendTokenResponse(token, roomData.get('title'), res);

    // newNode[uid] = true;
    // let membersRef = roomRef.child("members").child(uid).set(true).then(() => {
    // });
}

app.post("/slack/login", bodyParser.json(), bodyParser.urlencoded({extended: false}), async (req, res) => {
    //Decode and verify token
    try {
        let payload = jwt.verify(req.body.token, process.env.CLOWDR_JWT_KEY);

        // console.log(payload);
        let uid = payload.uid;
        let team = payload.team;
        let secret = payload.secret;
        let roomName = payload.roomName;
        let userQ = new Parse.Query(Parse.User);
        let user = await userQ.get(uid, {useMasterKey: true});
        if (user.get('loginKey') == secret) {
            let fakeSession = Parse.Object.extend("_Session");
            let newSession = new fakeSession();
            // console.log(user)
            newSession.set("user", user);
            newSession.set("createdWith", {action: "login", "authProvider": "clowdr"});
            newSession.set("restricted", false);
            newSession.set("expiresAt", moment().add("8", "hours").toDate());
            newSession.set("sessionToken", "r:" + await generateRandomString(24))
            newSession = await newSession.save({}, {useMasterKey: true});
            // console.log("Created new token: " + newSession.getSessionToken() + " for " + uid)
            return res.send({
                token: newSession.getSessionToken(),
                team: payload.team, roomName: payload.roomName
            });
        }
        res.send({status: "error"});
    } catch (err) {
        //TODO send login info
        console.log(err);
        res.status(403);
        res.send({status: err});
    }
})


//for testing...
// app.get("/video/token", async (req, res) => {
//     let payload = jwt.verify(req.query.token, process.env.CLOWDR_JWT_KEY);
//     console.log("Vidoe token from slack")
//     let conf = await getConference(payload.team);
//     try {
//         let token = videoToken(payload.identity, payload.roomSID, conf.config).toJwt();
//         //respond with the actual token
//         res.send(token);
//     } catch (err) {
//         console.log(err);
//         res.status(500);
//         res.send();
//     }
// });

//At boot, we should still clear out our cache locally
async function runBackend(){
    let promises = [];
    await createPrivileges();
    if(!process.env.SKIP_INIT) {
        let query = new Parse.Query(ClowdrInstance);
        query.find({useMasterKey: true}).then((instances) => {
            instances.forEach(
                async (inst) => {
                    try {
                        if (inst.get("slackWorkspace"))
                            promises.push(getConference(inst.get("slackWorkspace")).catch(err => {
                                console.log("Unable to load data for  " + inst.get("conferenceName"))
                                console.log(err);
                            }));
                    } catch (err) {
                        console.log(err);
                    }
                }
            )
        }).catch((err) => {
            console.log(err);
        });

    }

    Promise.all(promises).then(() => {
        app.listen(process.env.PORT || 3001, () =>
            console.log('Express server is running on localhost:3001')
        );
    });
}
runBackend();
