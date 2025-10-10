import { Injectable } from 'angular-ts-decorators';
import stackTrace from 'stacktrace-js';
import { BaseError } from '../errors/errors';
import { StoreKey } from '../store/store.enum';
import { TraceLogItem } from '../store/store.interface';
import { StoreService } from '../store/store.service';
import { LogLevel } from './log.enum';
import { LogQueueItem } from './log.interface';

@Injectable('LogService')
export class LogService {
  private $injector: ng.auto.IInjectorService;
  private $log: ng.ILogService;
  private _$q: ng.IQService;
  private _storeSvc: StoreService;

  static $inject = ['$injector', '$log'];
  constructor($injector: ng.auto.IInjectorService, $log: ng.ILogService) {
    this.$injector = $injector;
    this.$log = $log;
  }

  private get $q(): ng.IQService {
    if (!this._$q) {
      this._$q = this.$injector.get('$q');
    }
    return this._$q;
  }

  private get storeSvc(): StoreService {
    if (!this._storeSvc) {
      this._storeSvc = this.$injector.get('StoreService');
    }
    return this._storeSvc;
  }

  private addLogItemToQueue(logItem: LogQueueItem): ng.IPromise<void> {
    return this._storeSvc.get<LogQueueItem[]>(StoreKey.LogItemQueue).then((queue = []) => {
      queue.push(logItem);
      return this._storeSvc.set(StoreKey.LogItemQueue, queue);
    });
  }

  getLogEntries(): ng.IPromise<TraceLogItem[]> {
    return this.storeSvc.get<TraceLogItem[]>(StoreKey.TraceLog);
  }

  clear(): ng.IPromise<void> {
    return this.storeSvc.remove(StoreKey.TraceLog);
  }

  logError(error: BaseError, message?: string): ng.IPromise<void> {
    // Return if no error supplied or has already been logged
    if (error.logged) {
      //return;
      return this.$q.resolve();
    }

    // Mark this error as logged to prevent duplication in logs
    error.logged = true;

    // Output message to console
    if (message) {
      this.$log.warn(message, error);
    } else {
      this.$log.warn(error);
    }

    // Convert stack trace to show source files then add to queue and process
    return (
      !error.stack
        ? this.$q.resolve()
        : stackTrace.fromError(error).then((frames) => {
            if (frames) {
              const stack = `${error.name} (${error.constructor.name}): ${error.message}\n${frames
                .map((f) => `\tat ${f.functionName} (${f.fileName}:${f.lineNumber}:${f.columnNumber})`)
                .join('\n')}`;
              error.stack = stack;
            }
          })
    ).then(() => {
      this.addLogItemToQueue({
        level: LogLevel.Error,
        message,
        error
      }).then(() => this.processLogItemQueue());
    });
  }

  logInfo(message: object | string): ng.IPromise<void> {
    if (!message) {
      return;
    }

    // Output message to console, add to queue and process
    this.$log.info(message);
    this.addLogItemToQueue({
      level: LogLevel.Trace,
      message
    });
    return this.processLogItemQueue();
  }

  logWarning(message: object | string): ng.IPromise<void> {
    if (!message) {
      return this.$q.resolve();
    }

    // Output message to console, add to queue and process
    this.$log.warn(message);
    return this.addLogItemToQueue({
      level: LogLevel.Warn,
      message
    }).then(() => this.processLogItemQueue());
  }

  private processLogItemQueue(): ng.IPromise<void> {
    return this._storeSvc.get<LogQueueItem>(StoreKey.CurrentLogQueueItem).then((current) => {
      if (current) {
        return;
      }

      return this.storeSvc.get<LogQueueItem[]>(StoreKey.LogItemQueue).then((queue = []) => {
        if (queue.length === 0) {
          return;
        }

        // Get the next log item to process and lock the queue
        const currentLogQueueItem = queue.shift();
        return this.$q
          .all([
            this.storeSvc.set(StoreKey.CurrentLogQueueItem, currentLogQueueItem),
            this.storeSvc.set(StoreKey.LogItemQueue, queue)
          ])
          .then(() => {
            // Format log message
            let message =
              typeof currentLogQueueItem.message === 'object'
                ? JSON.stringify(currentLogQueueItem.message)
                : currentLogQueueItem.message ?? '';
            if (currentLogQueueItem.error) {
              message += currentLogQueueItem.error.stack
                ? `${currentLogQueueItem.error.stack.replace(/\s+/g, ' ')}`
                : '';
            }

            // Add log item to store
            const logItem: TraceLogItem = {
              level: currentLogQueueItem.level,
              message,
              timestamp: new Date().getTime()
            };
            return this.storeSvc.set(StoreKey.TraceLog, logItem).then(() => {
              // Process remaining messages by unlocking and recursing
              return this.storeSvc.remove(StoreKey.CurrentLogQueueItem).then(() => {
                return this.processLogItemQueue();
              });
            });
          });
      });
    });
  }
}
