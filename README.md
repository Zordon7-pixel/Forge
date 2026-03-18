# FORGE

## Install

```bash
npm run install:all
```

## iOS (Apple Health)

Apple Health integration uses `react-native-health` in the frontend package.

After installing dependencies and syncing Capacitor iOS, run CocoaPods install:

```bash
cd frontend
npm install
npx cap sync ios
cd ios/App
pod install
```

Then open the Xcode workspace and run the app on an iOS device.
