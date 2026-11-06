# Ringing calls

When someone starts a call, other members are rung like a phone call, even with the app closed.

- **iPhone:** the server sends a PushKit (VoIP) push to the topic `<bundle id>.voip` (`com.slavingia.servant.voip` by default; set `push.apnsTopic` in `server/data/config.json` for another bundle id) with the same APNs key as ordinary alerts. The app reports it to CallKit at once, so the system call screen appears. Answering opens the call in the app. The app registers its VoIP token at `PUT /v1/notifications/voip`.
- **Android:** the server sends a data-only FCM message (`type: call`). The app shows a full-screen incoming-call notification on the `calls` channel with Decline and Join. Android 14 and later may ask the person to allow full-screen notifications.
- **Older builds** that cannot ring keep getting the normal "is calling" alert.
- A call rings for 45 seconds. A push that arrives later is ignored, and the person who started the call is never rung.
- The open app shows its own ringing screen instead of the system one.

The native code lives in `app/modules/servant-call`. It needs a new native build; it cannot ship over the air.
