import angular from 'angular';
import { NgModule } from 'angular-ts-decorators';
import { WebExtBackgroundModule } from '../../webext-background/webext-background.module';
import { WebExtBackgroundService } from '../../webext-background/webext-background.service';
import { ChromiumBookmarkService } from '../shared/chromium-bookmark/chromium-bookmark.service';
import { ChromiumPlatformService } from '../shared/chromium-platform/chromium-platform.service';
import { initializeOffscreenBridge } from './chromium-offscreen-bridge';

@NgModule({
  id: 'ChromiumBackgroundModule',
  imports: [WebExtBackgroundModule],
  providers: [ChromiumBookmarkService, ChromiumPlatformService]
})
class ChromiumBackgroundModule {}

angular.element(document).ready(() => {
  angular.bootstrap(document, [(ChromiumBackgroundModule as NgModule).module.name]);
  const injector = angular.element(document.body).injector();
  if (injector) {
    const backgroundSvc = injector.get<WebExtBackgroundService>('WebExtBackgroundService');
    initializeOffscreenBridge(backgroundSvc);
  }
});
