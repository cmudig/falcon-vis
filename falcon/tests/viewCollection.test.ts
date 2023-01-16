import { ViewCollection } from "../src/core/views/viewCollection";
import { View1D } from "../src/core/views/view1D";

function dummyView() {
  // @ts-ignore
  const view = new View1D(null, null);
  return view;
}

describe("ViewCollection", () => {
  it("Import Exists", () => {
    expect(ViewCollection).toBeDefined();
  });

  it("Class construction", () => {
    const collection = new ViewCollection();
    expect(collection).toBeDefined();
    expect(typeof collection).toBe("object");
    expect(collection.views).toBeDefined();
  });

  it("Adding a view", () => {
    const collection = new ViewCollection();
    const view = dummyView();
    collection.add(view);

    expect(collection.size).toBe(1);
  });

  it("Adding a duplicate view", () => {
    const collection = new ViewCollection();
    const view = dummyView();

    collection.add(view);
    collection.add(view);

    expect(collection.size).toBe(1);
  });

  it("Adding different views", () => {
    const collection = new ViewCollection();
    const viewA = dummyView();
    const viewB = dummyView();

    collection.add(viewA);
    collection.add(viewB);

    expect(collection.size).toBe(2);
  });

  it("Return passive views and active views", () => {
    const collection = new ViewCollection();

    const passiveViewA = dummyView();
    passiveViewA.isActive = false;

    const passiveViewB = dummyView();
    passiveViewB.isActive = false;

    const activeView = dummyView();
    activeView.isActive = true;

    collection.add(passiveViewA);
    collection.add(passiveViewB);
    collection.add(activeView);

    expect(collection.active).toBeDefined();
    expect(collection.active).toBe(activeView);

    expect(collection.passive).toBeDefined();
    expect(collection.passive.length).toBe(2);
    expect(collection.passive[0]).toBe(passiveViewA);
    expect(collection.passive[1]).toBe(passiveViewB);
  });
});